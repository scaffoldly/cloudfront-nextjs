import { getInput, info, setFailed } from '@actions/core';
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  AddPermissionCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudFrontClient,
  UpdateDistributionCommand,
  GetDistributionConfigCommand,
} from '@aws-sdk/client-cloudfront';
import fs from 'fs';
import archiver from 'archiver';
import crypto from 'crypto';

const LAMBDA_FN = `
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // Function to remove /pages prefix
  const removePagesPrefix = (path) => {
    return path.replace('/pages', '');
  };

  // Find matching route, ensuring route.regex is present
  const matchedRoute = combinedRoutes.find((route) => {
    if (!route.regex) return false;
    const regex = new RegExp(route.regex);
    return regex.test(uri) && !!pagesManifest[route.page];
  });

  if (matchedRoute) {
    request.uri = removePagesPrefix(pagesManifest[matchedRoute.page]);
    return request;
  }

  return request;
};
`;

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64');
}

export class Action {
  async run(): Promise<void> {
    const distributionId = getInput('distribution-id', { required: true });
    const lambdaRoleArn = getInput('lambda-edge-role', { required: true });
    const workingDirectory = getInput('working-directory', { required: false }) || '.';

    try {
      const functionZipFile = await this.bundleLambda(workingDirectory, distributionId);
      const functionArn = await this.uploadLambda(distributionId, lambdaRoleArn, functionZipFile);
      await this.ensurePermissions(functionArn);
      await this.updateCloudFront(distributionId, functionArn);
    } catch (e: any) {
      setFailed(e.message);
    }
  }

  async bundleLambda(workingDirectory: string, distributionId: string): Promise<string> {
    info('Bundling Lambda Function...');

    const routesManifest = fs
      .readFileSync(`${workingDirectory}/.next/routes-manifest.json`)
      .toString();
    info(`Routes Manifest:\n${routesManifest}`);

    const pagesManifest = fs.readFileSync(`${workingDirectory}/.next/server/pages-manifest.json`);
    info(`Pages Manifest:\n${routesManifest}`);

    let lambdaFn = `
const routesManifest = ${JSON.stringify(routesManifest)};    
const pagesManifest = ${JSON.stringify(pagesManifest)};

// Combine dynamic and static routes into a single array in the global scope, ensuring they exist or defaulting to empty arrays
const combinedRoutes = [
    ...(routesManifest.dynamicRoutes || []),
    ...(routesManifest.staticRoutes || []),
];

${LAMBDA_FN}
    `;

    const workdir = fs.mkdtempSync(`${distributionId}`);
    const lambdaFile = `${workdir}/index.js`;
    fs.writeFileSync(lambdaFile, lambdaFn);

    const lambdadir = fs.mkdtempSync(`${distributionId}-lambda`);

    const outputFile = `${lambdadir}/lambda.zip`;
    const output = fs.createWriteStream(outputFile);
    const archive = archiver('zip');

    output.on('close', function () {
      info(`Lambda Function has been bundled. (${archive.pointer()} bytes)`);
    });

    archive.on('error', function (err) {
      setFailed(`Failed to bundle Lambda Function: ${err.message}`);
      throw err;
    });

    archive.pipe(output);
    archive.directory(workdir, false);

    await archive.finalize();

    return outputFile;
  }

  async uploadLambda(
    distributionId: string,
    roleArn: string,
    functionZipFile: string,
  ): Promise<string> {
    info('Uploading Lambda Function...');

    const runtime = 'nodejs18'; // the ".x" is appended when the function is created
    const functionName = `cloudfront-${distributionId}-originrequest-${runtime}`;
    const lambdaClient = new LambdaClient({ region: 'us-east-1' });

    try {
      const ZipFile = fs.readFileSync(functionZipFile);
      const localSha = sha256(ZipFile);

      let remoteSha: string | undefined = undefined;
      let functionArn: string | undefined = undefined;

      // Attempt to fetch the function and its CodeSha256 property
      try {
        const { Configuration } = await lambdaClient.send(
          new GetFunctionCommand({ FunctionName: functionName }),
        );
        if (Configuration && Configuration.CodeSha256 && Configuration.FunctionArn) {
          info(`Exsiting Function SHA: ${localSha}`);
          remoteSha = Configuration.CodeSha256;
          functionArn = Configuration.FunctionArn;
        }
      } catch (error: any) {
        if (error.name !== 'ResourceNotFoundException') {
          throw error;
        }
      }

      if (functionArn && localSha === remoteSha) {
        info('Function code has not changed, skipping upload');
        return functionArn;
      }

      if (remoteSha) {
        const response = await lambdaClient.send(
          new UpdateFunctionCodeCommand({
            FunctionName: functionName,
            ZipFile,
          }),
        );

        if (!response.FunctionArn) {
          throw new Error('FunctionArn was missing from the UpdateFunctionCodeCommand response');
        }

        info(`Function code updated: ${response.FunctionArn}`);

        return response.FunctionArn;
      }

      const response = await lambdaClient.send(
        new CreateFunctionCommand({
          FunctionName: functionName,
          Role: roleArn,
          Handler: 'index.handler',
          Code: {
            ZipFile,
          },
          Runtime: `${runtime}.x`,
        }),
      );

      if (!response.FunctionArn) {
        throw new Error('FunctionArn was missing from the CreateFunctionCommand response');
      }

      info(`Function created: ${response.FunctionArn}`);

      return response.FunctionArn;
    } catch (e: any) {
      setFailed(`Failed to upload Lambda Function: ${e.message}`);
      throw e;
    }
  }

  async ensurePermissions(functionArn: string): Promise<void> {
    const lambda = new LambdaClient({ region: 'us-east-1' });

    try {
      await lambda.send(
        new AddPermissionCommand({
          Action: 'lambda:InvokeFunction',
          FunctionName: functionArn,
          Principal: 'edgelambda.amazonaws.com',
          StatementId: 'AllowCloudFrontInvoke',
        }),
      );
    } catch (e: any) {
      if (e.name !== 'ResourceConflictException') {
        throw e;
      }
    }
  }

  async updateCloudFront(distributionId: string, functionArn: string): Promise<void> {
    info("Updating CloudFront Distribution's DefaultCacheBehavior...");

    const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

    try {
      const distributionConfig = await cloudfront.send(
        new GetDistributionConfigCommand({
          Id: distributionId,
        }),
      );

      if (
        !distributionConfig ||
        !distributionConfig.DistributionConfig ||
        !distributionConfig.ETag ||
        !distributionConfig.DistributionConfig.DefaultCacheBehavior
      ) {
        throw new Error('DistributionConfig is missing properties');
      }

      distributionConfig.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations = {
        Quantity: 1,
        Items: [
          {
            EventType: 'origin-request',
            LambdaFunctionARN: functionArn,
          },
        ],
      };

      await cloudfront.send(
        new UpdateDistributionCommand({
          Id: distributionId,
          DistributionConfig: distributionConfig.DistributionConfig,
          IfMatch: distributionConfig.ETag, // needed for conditional updates
        }),
      );
    } catch (e: any) {
      setFailed(`Failed to update CloudFront Distribution: ${e.message}`);
      throw e;
    }
  }
}
