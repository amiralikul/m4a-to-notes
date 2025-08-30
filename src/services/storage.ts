import { AwsClient } from 'aws4fetch';
import { UploadResult } from '../types';
import { getErrorMessage } from '../utils/errors';
import Logger from '../logger';

/**
 * R2 Storage Service
 * Handles file uploads, downloads, and presigned URL generation for R2 object storage
 */

export class StorageService {
  private bucket: R2Bucket;
  private logger: Logger;
  private env: Env;
  private awsClient: AwsClient | null = null;
  private r2Endpoint?: string;
  private bucketName?: string;

  constructor(bucket: R2Bucket, logger: Logger, env: Env) {
    this.bucket = bucket;
    this.logger = logger;
    this.env = env;
    
    // Initialize AWS client for presigned URLs if credentials are available
    if (env?.R2_ACCESS_KEY_ID && env?.R2_SECRET_ACCESS_KEY && env?.R2_ENDPOINT) {
      this.awsClient = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        region: env.R2_REGION || 'auto',
      });
      this.r2Endpoint = env.R2_ENDPOINT;
      this.bucketName = env.R2_BUCKET_NAME || 'm4a-to-notes';
    }
  }

  /**
   * Generate a presigned PUT URL for direct client uploads to R2
   * @param {string} fileName - Original filename
   * @param {string} contentType - MIME type of the file
   * @param {number} expiresIn - URL expiration time in seconds (default: 1 hour)
   * @returns {Promise<{uploadUrl: string, objectKey: string, expiresAt: string}>}
   */
  async generatePresignedUploadUrl(fileName: string, contentType: string, expiresIn: number = 3600): Promise<{uploadUrl: string, objectKey: string, expiresAt: string}> {
    try {
      // Check if bucket is available (for development)
      if (!this.bucket) {
        throw new Error('R2 bucket not configured. Please set up M4A_BUCKET binding in wrangler.toml');
      }

      // Generate object key with date-based path and UUID
      const objectKey = this.generateObjectKey(fileName);
      
      // Validate content type
      if (!this.isValidContentType(contentType)) {
        throw new Error(`Invalid content type: ${contentType}`);
      }

      // Check if AWS client is available for presigned URLs
      if (!this.awsClient) {
        throw new Error('R2 credentials not configured. Presigned URLs require R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ENDPOINT environment variables.');
      }

      // Create the URL for the PUT request
      const url = new URL(`${this.r2Endpoint}/${this.bucketName}/${objectKey}`);
      
      // Create a PUT request for signing
      const request = new Request(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
        },
      });

      // Generate presigned URL using aws4fetch
      const signedRequest = await this.awsClient.sign(request, {
        aws: { signQuery: true },
        expiresIn,
      });

      const uploadUrl = signedRequest.url;
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      this.logger.info('Generated presigned upload URL with aws4fetch', {
        objectKey,
        contentType,
        expiresAt,
        fileName,
        bucketName: this.bucketName
      });

      return {
        uploadUrl,
        objectKey,
        expiresAt
      };
    } catch (error) {
      this.logger.error('Failed to generate presigned URL', {
        fileName,
        contentType,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Generate a presigned GET URL for downloading files from R2
   * @param {string} objectKey - R2 object key
   * @param {number} expiresIn - URL expiration time in seconds (default: 1 hour)
   * @returns {Promise<string>} Presigned download URL
   */
  async generatePresignedDownloadUrl(objectKey: string, expiresIn: number = 3600): Promise<string> {
    try {
      // Check if AWS client is available for presigned URLs
      if (!this.awsClient) {
        throw new Error('R2 credentials not configured. Presigned URLs require R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ENDPOINT environment variables.');
      }

      // Create the URL for the GET request
      const url = new URL(`${this.r2Endpoint}/${this.bucketName}/${objectKey}`);
      
      // Create a GET request for signing
      const request = new Request(url, {
        method: 'GET',
      });

      // Generate presigned URL using aws4fetch
      const signedRequest = await this.awsClient.sign(request, {
        aws: { signQuery: true },
        expiresIn,
      });

      const downloadUrl = signedRequest.url;

      this.logger.info('Generated presigned download URL with aws4fetch', {
        objectKey,
        expiresIn,
        bucketName: this.bucketName
      });

      return downloadUrl;
    } catch (error) {
      this.logger.error('Failed to generate presigned download URL', {
        objectKey,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  async uploadContent(objectKey: string, content: string | ArrayBuffer | Blob, contentType: string): Promise<void> {
    try {
      await this.bucket.put(objectKey, content, {
        httpMetadata: {
          contentType
        }
      });

      this.logger.info('Content uploaded to R2', {
        objectKey,
        contentType,
        size: content.byteLength || content.length
      });
    } catch (error) {
      this.logger.error('Failed to upload content to R2', {
        objectKey,
        contentType,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Download content from R2
   * @param {string} objectKey - R2 object key
   * @returns {Promise<ArrayBuffer>} File content
   */
  async downloadContent(objectKey: string): Promise<ArrayBuffer> {
    try {
      // Try via binding with a few short retries to account for brief propagation delays
      const maxAttempts = 3;
      const delaysMs = [150, 400, 900];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const object = await this.bucket.get(objectKey);
        if (object) {
          const content = await object.arrayBuffer();
          this.logger.info('Content downloaded from R2', {
            objectKey,
            size: content.byteLength
          });
          return content;
        }
        if (attempt < delaysMs.length) {
          await new Promise(r => setTimeout(r, delaysMs[attempt]));
        }
      }

      // Fallback: if binding didn't find it, try direct S3 API if credentials are available
      if (this.awsClient && this.r2Endpoint && this.bucketName) {
        const url = new URL(`${this.r2Endpoint}/${this.bucketName}/${objectKey}`);
        const signed = await this.awsClient.sign(new Request(url, { method: 'GET' }), {
          aws: { signQuery: true },
        });
        const res = await fetch(signed);
        if (!res.ok) {
          throw new Error(`Object not found: ${objectKey}`);
        }
        const content = await res.arrayBuffer();
        this.logger.info('Content downloaded from R2 via S3 fallback', {
          objectKey,
          size: content.byteLength
        });
        return content;
      }

      // If no credentials for fallback, throw not found
      throw new Error(`Object not found: ${objectKey}`);
    } catch (error) {
      this.logger.error('Failed to download content from R2', {
        objectKey,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Check if an object exists in R2
   * @param {string} objectKey - R2 object key
   * @returns {Promise<boolean>}
   */
  async objectExists(objectKey: string): Promise<boolean> {
    try {
      const object = await this.bucket.head(objectKey);
      if (object !== null) return true;

      // Fallback to S3 HEAD if binding didn't find it and credentials exist
      if (this.awsClient && this.r2Endpoint && this.bucketName) {
        const url = new URL(`${this.r2Endpoint}/${this.bucketName}/${objectKey}`);
        const signed = await this.awsClient.sign(new Request(url, { method: 'HEAD' }), {
          aws: { signQuery: true },
        });
        const res = await fetch(signed);
        return res.ok;
      }

      return false;
    } catch (error) {
      if (getErrorMessage(error).includes('not found') || getErrorMessage(error).includes('NoSuchKey')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete an object from R2
   * @param {string} objectKey - R2 object key
   * @returns {Promise<void>}
   */
  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.bucket.delete(objectKey);
      
      this.logger.info('Object deleted from R2', {
        objectKey
      });
    } catch (error) {
      this.logger.error('Failed to delete object from R2', {
        objectKey,
        error: getErrorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Generate object key with date-based path structure
   * @param {string} fileName - Original filename
   * @returns {string} Object key
   */
  generateObjectKey(fileName: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    // Generate UUID for uniqueness
    const uuid = crypto.randomUUID();
    
    // Sanitize filename (remove spaces, special chars, keep only alphanumeric and dots)
    const sanitizedFileName = fileName
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '');
    
    return `audio/${year}/${month}/${day}/${uuid}-${sanitizedFileName}`;
  }

  /**
   * Generate transcript object key
   * @param {string} jobId - Job ID
   * @returns {string} Transcript object key
   */
  generateTranscriptKey(jobId: string): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    return `transcripts/${year}/${month}/${day}/${jobId}.txt`;
  }

  /**
   * Validate content type for audio files
   * @param {string} contentType - MIME type to validate
   * @returns {boolean} True if valid
   */
  isValidContentType(contentType: string): boolean {
    const validTypes = [
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a', // Alternative MIME type for M4A files used by some browsers/systems
      'audio/mpeg',
      'audio/wav',
      'audio/aac',
      'audio/ogg',
      'audio/webm'
    ];
    
    return validTypes.includes(contentType.toLowerCase());
  }
}