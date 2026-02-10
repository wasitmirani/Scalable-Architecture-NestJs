import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { APP_CONSTANTS } from "../constants/app.constants";

export interface ApiResponseData {
    success: boolean;
    statusCode: number;
    timestamp: string;
    message: string;
    data: any;
}

export class ApiResponse {

    /**
     * Generic success response
     */
    static success(data: any, message: string = APP_CONSTANTS.DEFAULT_MESSAGE, statusCode: number = HttpStatus.OK): ApiResponseData {
        return {
            success: true,
            statusCode,
            timestamp: new Date().toISOString(),
            message: message || 'Success',
            data,
        };
    }

    /**
     * Send HTTP response using Express Response object
     */
    static sendHttpResponse(res: Response, responseData: ApiResponseData): Response {
        return res.status(responseData.statusCode).json(responseData);
    }

    /**
     * Send success response with Express Response object
     */
    static sendSuccess(res: Response, data: any, message: string = APP_CONSTANTS.DEFAULT_MESSAGE, statusCode: number = HttpStatus.OK): Response {
        return this.sendHttpResponse(res, this.success(data, message, statusCode));
    }

    /**
     * Send error response with Express Response object
     */
    static sendError(res: Response, message: string, data: any = null, statusCode: number = HttpStatus.BAD_REQUEST): Response {
        return this.sendHttpResponse(res, this.error(message, data, statusCode));
    }

    /**
     * Send created response with Express Response object
     */
    static sendCreated(res: Response, data: any, message: string = 'Resource created successfully'): Response {
        return this.sendHttpResponse(res, this.created(data, message));
    }

    /**
     * Send not found response with Express Response object
     */
    static sendNotFound(res: Response, message: string = 'Resource not found', data: any = null): Response {
        return this.sendHttpResponse(res, this.notFound(message, data));
    }

    /**
     * Send unauthorized response with Express Response object
     */
    static sendUnauthorized(res: Response, message: string = 'Unauthorized'): Response {
        return this.sendHttpResponse(res, this.unauthorized(message));
    }

    /**
     * Send forbidden response with Express Response object
     */
    static sendForbidden(res: Response, message: string = 'Forbidden'): Response {
        return this.sendHttpResponse(res, this.forbidden(message));
    }

    /**
     * Send validation error response with Express Response object
     */
    static sendValidationError(res: Response, message: string, data: any = null): Response {
        return this.sendHttpResponse(res, this.validationError(message, data));
    }

    /**
     * Send conflict response with Express Response object
     */
    static sendConflict(res: Response, message: string = 'Resource conflict', data: any = null): Response {
        return this.sendHttpResponse(res, this.conflict(message, data));
    }

    /**
     * Send internal error response with Express Response object
     */
    static sendInternalError(res: Response, message: string = 'Internal server error', data: any = null): Response {
        return this.sendHttpResponse(res, this.internalError(message, data));
    }

    /**
     * Generic error response
     */
    static error(message: string, data: any = null, statusCode: number = HttpStatus.BAD_REQUEST): ApiResponseData {
        return {
            success: false,
            statusCode,
            timestamp: new Date().toISOString(),
            message: message || 'Bad Request',
            data,
        };
    }

    /**
     * Validation error response
     */
    static validationError(data: any = null, message: string = 'Validation Error'): ApiResponseData {
        return {
            success: false,
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            timestamp: new Date().toISOString(),
            message: message || 'Validation Error',
            data,
        };
    }

    /**
     * Created response (201)
     */
    static created(data: any, message: string = 'Resource created successfully'): ApiResponseData {
        return {
            success: true,
            statusCode: HttpStatus.CREATED,
            timestamp: new Date().toISOString(),
            message,
            data,
        };
    }

    /**
     * No content response (204)
     */
    static noContent(message: string = 'No content'): ApiResponseData {
        return {
            success: true,
            statusCode: HttpStatus.NO_CONTENT,
            timestamp: new Date().toISOString(),
            message,
            data: null,
        };
    }

    /**
     * Unauthorized response (401)
     */
    static unauthorized(message: string = 'Unauthorized'): ApiResponseData {
        return {
            success: false,
            statusCode: HttpStatus.UNAUTHORIZED,
            timestamp: new Date().toISOString(),
            message,
            data: null,
        };
    }

    /**
     * Forbidden response (403)
     */
    static forbidden(message: string = 'Forbidden'): ApiResponseData {
        return {
            success: false,
            statusCode: HttpStatus.FORBIDDEN,
            timestamp: new Date().toISOString(),
            message,
            data: null,
        };
    }

    /**
     * Not found response (404)
     */
    static notFound(message: string = 'Resource not found', data: any = null): ApiResponseData {
        return {
            success: false,
            statusCode: HttpStatus.NOT_FOUND,
            timestamp: new Date().toISOString(),
            message,
            data,
        };
    }

    /**
     * Conflict response (409)
     */
    static conflict(message: string = 'Resource conflict', data: any = null): ApiResponseData {
        return {
            success: false,
            statusCode: HttpStatus.CONFLICT,
            timestamp: new Date().toISOString(),
            message,
            data,
        };
    }

    /**
     * Internal server error response (500)
     */
    static internalError(message: string = 'Internal server error', data: any = null): ApiResponseData {
        return {
            success: false,
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            timestamp: new Date().toISOString(),
            message,
            data,
        };
    }

}
