import type {Config} from '@verdaccio/types';

export interface S3Config extends Config {
  bucket: string;
  keyPrefix: string;
  endpoint?: string;
  region?: string;
  s3ForcePathStyle?: boolean;
  tarballACL?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  proxy?: string;
  database?: 'bucket' | 'dynamo' | 'postgres';
  dynamoTableName?: string;
  dynamoEndpoint?: string;
  dynamoRegion?: string;
  postgres?: {
    url?: string;
    pool?: Record<string, unknown>;
    autoCreateSchema?: boolean;
    tablePrefix?: string;
  };
}
