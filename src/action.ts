import { debug, getInput, info, setFailed } from '@actions/core';
import * as artifact from '@actions/artifact';
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  AddPermissionCommand,
  PublishVersionCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudFrontClient,
  UpdateDistributionCommand,
  GetDistributionConfigCommand,
} from '@aws-sdk/client-cloudfront';
import fs from 'fs';
import archiver from 'archiver';
import crypto from 'crypto';

const { GITHUB_REPOSITORY } = process.env;

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
    const distributionId =
      getInput('distribution-id', { required: false }) || process.env.AWS_DISTRIBUTION_ID;
    const lambdaEdgeRole =
      getInput('lambda-edge-role', { required: false }) || process.env.AWS_LAMBDA_EDGE_ROLE;
    const workingDirectory = getInput('working-directory', { required: false }) || '.';

    const [, repository] = (GITHUB_REPOSITORY || '').split('/');

    const functionNamePrefix =
      getInput('function-name-prefix', { required: false }) || `${repository}-${distributionId}-`;

    if (!distributionId) {
      throw new Error("Missing required input 'distribution-id'");
    }

    if (!lambdaEdgeRole) {
      throw new Error("Missing required input 'lambda-edge-role'");
    }

    // Double Base64 so it can get out of Secret Masking
    debug(
      `distributionId: ${Buffer.from(Buffer.from(distributionId).toString('base64')).toString(
        'base64',
      )}`,
    );
    debug(
      `lambdaEdgeRole: ${Buffer.from(Buffer.from(lambdaEdgeRole).toString('base64')).toString(
        'base64',
      )}`,
    );

    try {
      const functionZipFile = await this.bundleLambda(workingDirectory, distributionId);
      let { functionArn, codeSha, changed } = await this.uploadLambda(
        functionNamePrefix,
        lambdaEdgeRole,
        functionZipFile,
      );

      await this.ensurePermissions(functionArn);

      if (changed) {
        functionArn = await this.publishLambda(functionArn, codeSha);
        await this.updateCloudFront(distributionId, functionArn);
      }
    } catch (e: any) {
      setFailed(e.message);
      // throw e;
    }
  }

  async bundleLambda(workingDirectory: string, distributionId: string): Promise<string> {
    info('Bundling Lambda Function...');

    const routesManifest = JSON.stringify(
      JSON.parse(fs.readFileSync(`${workingDirectory}/.next/routes-manifest.json`).toString()),
    );

    debug(`Routes Manifest:\n${routesManifest}`);

    const pagesManifest = JSON.stringify(
      JSON.parse(
        fs.readFileSync(`${workingDirectory}/.next/server/pages-manifest.json`).toString(),
      ),
    );

    debug(`Pages Manifest:\n${pagesManifest}`);

    let lambdaFn = `
/*
* This script is managed by the cloudfront-nextjs GitHub Action.
*
*     GitHub Repository: ${GITHUB_REPOSITORY}
*     Distrubition ID: ${distributionId}
*     Runtime: nodejs18.x
*     Purpose: CloudFront Origin Request for Next.js
*
*/
const routesManifest = ${routesManifest};

const pagesManifest = ${pagesManifest};

// Combine dynamic and static routes into a single array in the global scope, ensuring they exist or defaulting to empty arrays
const combinedRoutes = [
    ...(routesManifest.dynamicRoutes || []),
    ...(routesManifest.staticRoutes || []),
];

${LAMBDA_FN}
    `;

    const workdir = `/tmp/${distributionId}`;
    const lambdadir = `/tmp/${distributionId}-lambda`;
    fs.mkdirSync(workdir);
    fs.mkdirSync(lambdadir);

    const lambdaFile = `${workdir}/index.js`;
    fs.writeFileSync(lambdaFile, lambdaFn);

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

    const lambdaArtifact = artifact.create();

    const artifactResponse = await lambdaArtifact.uploadArtifact(
      'lambda.zip',
      [outputFile],
      lambdadir,
      {
        continueOnError: true,
      },
    );
    debug('Upload Artifact Response: ' + JSON.stringify(artifactResponse));

    return outputFile;
  }

  async uploadLambda(
    functionNamePrefix: string,
    roleArn: string,
    functionZipFile: string,
  ): Promise<{ functionArn: string; codeSha: string; changed: boolean }> {
    info('Uploading Lambda Function...');
    const functionName = `${functionNamePrefix}origin-request`;
    const lambdaClient = new LambdaClient({ region: 'us-east-1' });

    try {
      const ZipFile = fs.readFileSync(functionZipFile);
      const localSha = sha256(ZipFile);

      let remoteSha: string | undefined = undefined;
      let functionArn: string | undefined = undefined;

      // Attempt to fetch the function and its CodeSha256 property
      try {
        const response = await lambdaClient.send(
          new GetFunctionCommand({ FunctionName: functionName }),
        );

        debug('GetFunctionCommand Response: ' + JSON.stringify(response));

        const { Configuration } = response;
        if (!Configuration) {
          throw new Error('Invalid GetFunctionCommand response');
        }

        const { FunctionArn, CodeSha256 } = Configuration;

        if (!FunctionArn || !CodeSha256) {
          throw new Error(
            'FunctionArn or CodeSha256 was missing from the GetFunctionCommand response',
          );
        }

        info(`Exsiting Function SHA: ${localSha}`);

        functionArn = FunctionArn;
        remoteSha = CodeSha256;
      } catch (error: any) {
        if (error.name !== 'ResourceNotFoundException') {
          throw error;
        }
      }

      if (functionArn && localSha === remoteSha) {
        info('Function code has not changed, skipping upload');
        return { functionArn, codeSha: remoteSha, changed: false };
      }

      if (remoteSha) {
        const response = await lambdaClient.send(
          new UpdateFunctionCodeCommand({
            FunctionName: functionName,
            ZipFile,
          }),
        );

        debug('UpdateFunctionCodeCommand Response: ' + JSON.stringify(response));

        const { FunctionArn, CodeSha256 } = response;

        if (!FunctionArn || !CodeSha256) {
          throw new Error('Invalid UpdateFunctionCodeCommand response');
        }

        info(`Function code updated: ${response.FunctionArn}`);

        return { functionArn: FunctionArn, codeSha: CodeSha256, changed: true };
      } else {
        const response = await lambdaClient.send(
          new CreateFunctionCommand({
            FunctionName: functionName,
            Role: roleArn,
            Handler: 'index.handler',
            Code: {
              ZipFile,
            },
            Runtime: 'nodejs18.x',
          }),
        );

        debug('CreateFunctionCommand Response: ' + JSON.stringify(response));

        const { FunctionArn, CodeSha256 } = response;

        if (!FunctionArn || !CodeSha256) {
          throw new Error('FunctionArn was missing from the CreateFunctionCommand response');
        }

        info(`Function created: ${response.FunctionArn}`);

        return { functionArn: FunctionArn, codeSha: CodeSha256, changed: true };
      }
    } catch (e: any) {
      setFailed(`Failed to upload Lambda Function: ${e.message}`);
      throw e;
    }
  }

  async publishLambda(functionArn: string, codeSha: string): Promise<string> {
    info('Publishing Lambda Function Version...');
    const lambdaClient = new LambdaClient({ region: 'us-east-1' });

    try {
      const response = await lambdaClient.send(
        new GetFunctionCommand({ FunctionName: functionArn }),
      );

      debug('GetFunctionCommand Response: ' + JSON.stringify(response));

      const { Configuration } = response;

      if (!Configuration) {
        throw new Error('Invalid GetFunctionCommand response');
      }

      const { State, LastUpdateStatus } = Configuration;

      if (State !== 'Active' || LastUpdateStatus !== 'Successful') {
        info('Waiting for Lambda function to be Active and Successful');
        return new Promise((resolve) => {
          setTimeout(() => {
            this.publishLambda(functionArn, codeSha).then((functionArn) => {
              resolve(functionArn);
            });
          }, 1000);
        });
      }
    } catch (e: any) {
      setFailed(`Failed to get Lambda Function: ${e.message}`);
      throw e;
    }

    try {
      const response = await lambdaClient.send(
        new PublishVersionCommand({ FunctionName: functionArn, CodeSha256: codeSha }),
      );

      debug('PublishVersionCommand Response: ' + JSON.stringify(response));

      const { FunctionArn } = response;

      if (!FunctionArn) {
        throw new Error('Invalid PublishVersionCommand response');
      }

      return FunctionArn;
    } catch (e: any) {
      setFailed(`Failed to publish Lambda Function: ${e.message}`);
      throw e;
    }
  }

  async ensurePermissions(functionArn: string): Promise<void> {
    const lambda = new LambdaClient({ region: 'us-east-1' });

    try {
      const response = await lambda.send(
        new AddPermissionCommand({
          Action: 'lambda:InvokeFunction',
          FunctionName: functionArn,
          Principal: 'edgelambda.amazonaws.com',
          StatementId: 'AllowCloudFrontInvoke',
        }),
      );

      debug('AddPermissionCommand Response: ' + JSON.stringify(response));
    } catch (e: any) {
      if (e.name !== 'ResourceConflictException') {
        throw e;
      }
    }
  }

  async updateCloudFront(distributionId: string, functionArn: string): Promise<void> {
    info(`Updating CloudFront Origin Request with Functiion ARN: ${functionArn}`);

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

      const response = await cloudfront.send(
        new UpdateDistributionCommand({
          Id: distributionId,
          DistributionConfig: distributionConfig.DistributionConfig,
          IfMatch: distributionConfig.ETag, // needed for conditional updates
        }),
      );

      debug('UpdateDistributionCommand Response: ' + JSON.stringify(response));
    } catch (e: any) {
      setFailed(`Failed to update CloudFront Distribution: ${e.message}`);
      throw e;
    }
  }
}
