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

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64');
}

export class Action {
  async run(): Promise<void> {
    const distributionId = getInput('distribution-id', { required: true });
    const lambdaRoleArn = getInput('lambda-execution-role-arn', { required: true });
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

    const workdir = fs.mkdtempSync(distributionId);
    fs.copyFileSync('../origin-request-lambda/index.js', `${workdir}/index.js`);
    fs.copyFileSync(
      `${workingDirectory}/.next/routes-manifest.json`,
      `${workdir}/routes-manifest.json`,
    );
    fs.copyFileSync(
      `${workingDirectory}/.next/server/pages-manifest.json`,
      `${workdir}/pages-manifest.json`,
    );

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

    const runtime = 'nodejs18';
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
