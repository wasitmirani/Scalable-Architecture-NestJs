import { 
  BusinessException, 
  ValidationException, 
  UnauthorizedException,
  NotFoundException,
  ConflictException 
} from './custom.exceptions';

describe('Custom Exceptions', () => {
  describe('BusinessException', () => {
    it('should create business exception with default code', () => {
      const exception = new BusinessException('Business error');
      
      expect(exception.getStatus()).toBe(400);
      expect(exception.getResponse()).toEqual({
        message: 'Business error',
        code: 'BUSINESS_ERROR',
      });
    });

    it('should create business exception with custom code', () => {
      const exception = new BusinessException('Business error', 'CUSTOM_ERROR');
      
      expect(exception.getResponse()).toEqual({
        message: 'Business error',
        code: 'CUSTOM_ERROR',
      });
    });
  });

  describe('ValidationException', () => {
    it('should create validation exception with errors', () => {
      const errors = [
        { field: 'email', errors: ['must be email'] },
        { field: 'password', errors: ['too short'] },
      ];
      
      const exception = new ValidationException(errors);
      
      expect(exception.getStatus()).toBe(422);
      expect(exception.getResponse()).toEqual({
        message: 'Validation failed',
        error: 'ValidationError',
        details: errors,
      });
    });
  });

  describe('UnauthorizedException', () => {
    it('should create unauthorized exception with default message', () => {
      const exception = new UnauthorizedException();
      
      expect(exception.getStatus()).toBe(401);
      expect(exception.getResponse()).toEqual({
        message: 'Unauthorized access',
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    });

    it('should create unauthorized exception with custom message', () => {
      const exception = new UnauthorizedException('Custom unauthorized message');
      
      expect(exception.getResponse()).toEqual({
        message: 'Custom unauthorized message',
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('NotFoundException', () => {
    it('should create not found exception with default resource', () => {
      const exception = new NotFoundException();
      
      expect(exception.getStatus()).toBe(404);
      expect(exception.getResponse()).toEqual({
        message: 'Resource not found',
        error: 'Not Found',
        code: 'NOT_FOUND',
      });
    });

    it('should create not found exception with custom resource', () => {
      const exception = new NotFoundException('User');
      
      expect(exception.getResponse()).toEqual({
        message: 'User not found',
        error: 'Not Found',
        code: 'NOT_FOUND',
      });
    });
  });

  describe('ConflictException', () => {
    it('should create conflict exception with default message', () => {
      const exception = new ConflictException();
      
      expect(exception.getStatus()).toBe(409);
      expect(exception.getResponse()).toEqual({
        message: 'Resource conflict',
        error: 'Conflict',
        code: 'CONFLICT',
      });
    });

    it('should create conflict exception with custom message', () => {
      const exception = new ConflictException('Custom conflict message');
      
      expect(exception.getResponse()).toEqual({
        message: 'Custom conflict message',
        error: 'Conflict',
        code: 'CONFLICT',
      });
    });
  });
});