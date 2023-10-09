import { debug, getInput, info } from '@actions/core';
import * as artifact from '@actions/artifact';
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
  CreateInvalidationCommand,
  GetDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import fs from 'fs';
import archiver from 'archiver';
import crypto from 'crypto';
import packageJson from '../package.json';

const { GITHUB_REPOSITORY } = process.env;

const RUNTIME = 'nodejs18.x';
const LAMBDA_FN = `
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // Function to remove /pages prefix
  const removePagesPrefix = (path) => {
    return path.replace('pages/', '/');
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

const sha256 = (buffer: Buffer) => {
  return crypto.createHash('sha256').update(buffer).digest('base64');
};

const normalize = (obj: any) => {
  return Object.keys(obj)
    .sort()
    .reduce((acc: any, key: string) => {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        // If the property is an object, recursively sort its keys.
        acc[key] = normalize(obj[key]);
      } else {
        // Otherwise, simply add it to the accumulator object.
        acc[key] = obj[key];
      }
      return acc;
    }, {});
};

export class Action {
  async run(): Promise<void> {
    const distributionId =
      getInput('distribution-id', { required: false }) || process.env.AWS_DISTRIBUTION_ID;
    const lambdaEdgeRole =
      getInput('lambda-edge-role', { required: false }) || process.env.AWS_LAMBDA_EDGE_ROLE;
    const workingDirectory = getInput('working-directory', { required: false }) || '.';
    const invalidate = getInput('invalidate', { required: false }) || undefined;
    const waitForDeployment = Boolean(
      getInput('wait-for-deployment', { required: false }) || 'true',
    );

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

    const functionZipFile = await this.bundleLambda(workingDirectory, distributionId);
    let { functionArn, codeSha, changed } = await this.uploadLambda(
      functionNamePrefix,
      lambdaEdgeRole,
      functionZipFile,
    );

    functionArn = await this.awaitPublish(functionArn, codeSha);

    await this.ensurePermissions(functionArn);
    await this.updateCloudFront(distributionId, functionArn, waitForDeployment);

    if (!changed && invalidate) {
      await this.invalidateCloudFront(distributionId, invalidate, waitForDeployment);
    }
  }

  async bundleLambda(workingDirectory: string, distributionId: string): Promise<string> {
    info('Bundling Lambda Function...');

    let routesManifest, pagesManifest: string;

    try {
      routesManifest = JSON.stringify(
        normalize(
          JSON.parse(fs.readFileSync(`${workingDirectory}/.next/routes-manifest.json`).toString()),
        ),
      );
    } catch (e: unknown) {
      throw new Error(
        `Error reading ${workingDirectory}/.next/routes-manifest.json. Did you run \`next export\`?`,
        {
          cause: e,
        },
      );
    }

    debug(`Routes Manifest:\n${routesManifest}`);

    try {
      pagesManifest = JSON.stringify(
        normalize(
          JSON.parse(
            fs.readFileSync(`${workingDirectory}/.next/server/pages-manifest.json`).toString(),
          ),
        ),
      );
    } catch (e: unknown) {
      throw new Error(
        `Error reading ${workingDirectory}/.next/server/pages-manifest.json. Did you run \`next export\`?`,
        {
          cause: e,
        },
      );
    }

    debug(`Pages Manifest:\n${pagesManifest}`);

    let originRequestFn = `
/*
* This script is managed by the ${packageJson.name}@${packageJson.version} GitHub Action.
*
*     GitHub Repository: ${GITHUB_REPOSITORY}
*     Distrubition ID: ${distributionId}
*     Runtime: ${RUNTIME}
*     Purpose: CloudFront Origin Request for Next.js
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
    fs.writeFileSync(lambdaFile, originRequestFn);

    const outputFile = `${lambdadir}/lambda.zip`;
    const output = fs.createWriteStream(outputFile);
    const archive = archiver('zip');

    output.on('close', function () {
      info(`Lambda Function has been bundled. (${archive.pointer()} bytes)`);
    });

    archive.on('error', function (err) {
      throw new Error(`Error archiving Lambda Function`, { cause: err });
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

      info(`Local Function SHA: ${localSha}`);

      let remoteSha: string | undefined = undefined;
      let functionArn: string | undefined = undefined;

      // Attempt to fetch the function and its CodeSha256 property
      try {
        const response = await lambdaClient.send(
          new GetFunctionCommand({ FunctionName: `${functionName}:$LATEST` }),
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

        info(`Existing Function ARN: ${FunctionArn}`);
        info(`Existing Function SHA: ${localSha}`);

        functionArn = FunctionArn;
        remoteSha = CodeSha256;
      } catch (error: any) {
        if (error.name !== 'ResourceNotFoundException') {
          throw error;
        }
      }

      console.log('!!! functionArn', functionArn);
      console.log('!!! remoteSha', remoteSha);
      console.log('!!! localSha', localSha);

      // Purposefully using "==" to check
      if (functionArn && remoteSha && localSha.trim() == remoteSha.trim()) {
        info('Function code has not changed, skipping upload');
        return { functionArn, codeSha: remoteSha, changed: false };
      }

      if (remoteSha) {
        const response = await lambdaClient.send(
          new UpdateFunctionCodeCommand({
            FunctionName: functionName,
            ZipFile,
            Publish: true,
          }),
        );

        debug('UpdateFunctionCodeCommand Response: ' + JSON.stringify(response));

        const { FunctionArn, CodeSha256 } = response;

        if (!FunctionArn || !CodeSha256) {
          throw new Error('Invalid UpdateFunctionCodeCommand response');
        }

        info(`Function code updated: ${response.FunctionArn}, new sha is ${CodeSha256}`);

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
            Runtime: RUNTIME,
            Publish: true,
          }),
        );

        debug('CreateFunctionCommand Response: ' + JSON.stringify(response));

        const { FunctionArn, CodeSha256 } = response;

        if (!FunctionArn || !CodeSha256) {
          throw new Error('FunctionArn was missing from the CreateFunctionCommand response');
        }

        info(`Function created: ${response.FunctionArn}, sha is ${CodeSha256}`);

        return { functionArn: FunctionArn, codeSha: CodeSha256, changed: true };
      }
    } catch (err: unknown) {
      throw new Error(`Error uploading Lambda Function`, { cause: err });
    }
  }

  async awaitPublish(functionArn: string, codeSha: string): Promise<string> {
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
        info(`Waiting for ${functionArn} deployment...`);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              this.awaitPublish(functionArn, codeSha).then((functionArn) => {
                resolve(functionArn);
              });
            } catch (e: unknown) {
              reject(e);
            }
          }, 1000);
        });
      }

      return functionArn;
    } catch (err: any) {
      throw new Error(`Error getting Lambda Function`, { cause: err });
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

  async updateCloudFront(
    distributionId: string,
    functionArn: string,
    waitForDeployment: boolean,
  ): Promise<void> {
    info(`Ensuring CloudFront has an Origin Request with Function ARN: ${functionArn}`);

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

      let { LambdaFunctionAssociations: lambdas } =
        distributionConfig.DistributionConfig.DefaultCacheBehavior;

      if (
        lambdas &&
        lambdas.Quantity == 1 &&
        lambdas.Items &&
        lambdas.Items.length == 1 &&
        lambdas.Items[0].EventType == 'origin-request' &&
        lambdas.Items[0].LambdaFunctionARN == functionArn
      ) {
        info('Lambda Function has not changed, skipping update...');
        return;
      }

      lambdas = {
        Quantity: 1,
        Items: [
          {
            EventType: 'origin-request',
            LambdaFunctionARN: functionArn,
            IncludeBody: false,
          },
        ],
      };

      info(
        `Updating Lambda Function Associations for the Default Cache Behavior:\n${JSON.stringify(
          lambdas,
          null,
          2,
        )}`,
      );

      distributionConfig.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations =
        lambdas;

      const response = await cloudfront.send(
        new UpdateDistributionCommand({
          Id: distributionId,
          DistributionConfig: distributionConfig.DistributionConfig,
          IfMatch: distributionConfig.ETag, // needed for conditional updates
        }),
      );

      debug('UpdateDistributionCommand Response: ' + JSON.stringify(response));
    } catch (err: unknown) {
      throw new Error(`Error updating CloudFront Distribution`, { cause: err });
    }

    if (waitForDeployment) {
      await this.awaitDeployment(distributionId);
    }
  }

  async invalidateCloudFront(
    distributionId: string,
    path: string,
    waitForDeployment: boolean,
  ): Promise<void> {
    info(`Invalidating CloudFront Distribution ${distributionId} path: ${path}`);

    const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

    try {
      const response = await cloudfront.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            Paths: {
              Quantity: 1,
              Items: [path],
            },
            CallerReference: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_NUMBER}`,
          },
        }),
      );

      debug('CreateInvalidationCommand Response: ' + JSON.stringify(response));

      const { Invalidation } = response;

      if (!Invalidation || !Invalidation.Id || !Invalidation.Status) {
        throw new Error('Invalidation is missing properties');
      }

      info(`Invalidation created: ${Invalidation.Id}, status: ${Invalidation.Status}`);
    } catch (err: unknown) {
      throw new Error(`Error invalidating CloudFront Distribution`, { cause: err });
    }

    if (waitForDeployment) {
      await this.awaitDeployment(distributionId);
    }
  }

  async awaitDeployment(distributionId: string): Promise<void> {
    const cloudfront = new CloudFrontClient({ region: 'us-east-1' });

    try {
      const response = await cloudfront.send(
        new GetDistributionCommand({
          Id: distributionId,
        }),
      );

      debug('GetDistributionCommand Response: ' + JSON.stringify(response));

      const { Distribution } = response;

      if (!Distribution || !Distribution.Status || !Distribution.Id) {
        throw new Error('Distribution is missing properties');
      }

      if (Distribution.Status === 'Deployed') {
        info(`CloudFront Distribution ${distributionId} has been deployed`);
        return;
      }

      info(`CloudFront Distribution deployment status is ${Distribution.Status}, waiting...`);

      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            this.awaitDeployment(distributionId).then(() => {
              resolve();
            });
          } catch (e: unknown) {
            reject(e);
          }
        }, 5000);
      });
    } catch (err: unknown) {
      throw new Error(`Error getting CloudFront Distribution`, { cause: err });
    }
  }
}
