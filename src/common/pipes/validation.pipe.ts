import { PipeTransform, Injectable, ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ValidationException } from '../exceptions/custom.exceptions';
import { ApiResponse } from '../utils/api.response';

@Injectable()
export class ValidationPipe implements PipeTransform<any> {
  async transform(value: any, { metatype }: ArgumentMetadata) {
    if (!metatype || !this.toValidate(metatype)) {
      return value;
    }

    const object = plainToInstance(metatype, value);
    const errors = await validate(object);

    if (errors.length > 0) {
      const formattedErrors = this.formatErrors(errors);
      return ApiResponse.validationError(formattedErrors);
    }

    return value;
  }

  private toValidate(metatype: Function): boolean {
    const types: Function[] = [String, Boolean, Number, Array, Object];
    return !types.includes(metatype);
  }

  private formatErrors(errors: any[]): any[] {
    return errors.map(error => {
      const constraints = error.constraints ? Object.values(error.constraints) : [];
      const children = error.children ? this.formatErrors(error.children) : [];

      return {
        field: error.property,
        value: error.value,
        errors: constraints,
        children: children.length > 0 ? children : undefined,
      };
    });
  }
}