import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponseData } from '../utils/api.response';

export interface Response<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T;
  timestamp: string;
  path: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, Response<T> | ApiResponseData> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T> | ApiResponseData> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    return next.handle().pipe(
      map(data => {
        // Check if data is already an ApiResponseData object
        // ApiResponseData has: success, statusCode, timestamp, message, data
        if (data && 
            typeof data === 'object' && 
            'success' in data && 
            'statusCode' in data && 
            'timestamp' in data && 
            'message' in data && 
            'data' in data &&
            typeof data.success === 'boolean' &&
            typeof data.statusCode === 'number') {
          // It's already a formatted ApiResponseData, return as-is
          // Always set the HTTP status code from ApiResponseData
          response.statusCode = data.statusCode;
          return data as ApiResponseData;
        }

        // Otherwise, wrap it in the standard response format
        const statusCode = response.statusCode || 200;
        
        return {
          success: true,
          statusCode,
          message: data?.message || 'Request successful',
          data: data?.data || data,
          timestamp: new Date().toISOString(),
          path: request.url,
        };
      }),
    );
  }
}