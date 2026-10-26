import { Helpers } from './helpers';
import { ValidationException } from '../exceptions/custom.exceptions';
import { APP_CONSTANTS } from '../constants/app.constants';

export type NumberRule = number | { value: number; message?: string };
export type MatchRule = string | { field: string; message?: string };
export type InRule = any[] | { values: any[]; message?: string };

export type ValidationRule = {
  required?: boolean | string;
  email?: boolean | string;
  minLength?: NumberRule;
  maxLength?: NumberRule;
  strongPassword?: boolean | string;
  numeric?: boolean | string;
  min?: NumberRule;
  max?: NumberRule;
  match?: MatchRule;
  in?: InRule;
  custom?: (value: any, data: Record<string, any>) => string | null | undefined;
};

export type ValidationSchema = Record<string, ValidationRule>;

export interface FieldError {
  field: string;
  errors: string[];
}

export interface ValidationResult {
  isValid: boolean;
  errors: Record<string, string[]>;
  errorList: FieldError[];
}

/**
 * Reusable schema-based validation helpers.
 */
export class ValidationHelper {
  /** Validate data and return structured errors (does not throw). */
  static validate(data: Record<string, any>, schema: ValidationSchema): ValidationResult {
    const errors: Record<string, string[]> = {};
    const source = data ?? {};

    for (const [field, rules] of Object.entries(schema)) {
      const fieldErrors = this.validateField(field, source[field], rules, source);
      if (fieldErrors.length) {
        errors[field] = fieldErrors;
      }
    }

    return this.toResult(errors);
  }

  /** Validate and throw ValidationException when invalid. */
  static assert(data: Record<string, any>, schema: ValidationSchema): void {
    const result = this.validate(data, schema);
    if (!result.isValid) {
      throw new ValidationException(result.errorList);
    }
  }

  /** Validate a single field against its rules. */
  static validateField(
    field: string,
    value: any,
    rules: ValidationRule,
    data: Record<string, any> = {},
  ): string[] {
    const label = this.humanize(field);
    const isEmpty = Helpers.isEmpty(value);

    if (rules.required && isEmpty) {
      return [this.message(rules.required, `${label} is required`)];
    }

    if (isEmpty) {
      return [];
    }

    const errors: string[] = [];

    if (rules.email && !Helpers.isValidEmail(String(value))) {
      errors.push(this.message(rules.email, `${label} must be a valid email`));
    }

    if (rules.numeric !== undefined && !this.isNumeric(value)) {
      errors.push(this.message(rules.numeric, `${label} must be a number`));
    }

    if (rules.minLength !== undefined) {
      const { value: min, message } = this.numberRule(rules.minLength);
      if (String(value).length < min) {
        errors.push(message || `${label} must be at least ${min} characters`);
      }
    }

    if (rules.maxLength !== undefined) {
      const { value: max, message } = this.numberRule(rules.maxLength);
      if (String(value).length > max) {
        errors.push(message || `${label} must be at most ${max} characters`);
      }
    }

    if (rules.min !== undefined) {
      const { value: min, message } = this.numberRule(rules.min);
      if (Number(value) < min) {
        errors.push(message || `${label} must be at least ${min}`);
      }
    }

    if (rules.max !== undefined) {
      const { value: max, message } = this.numberRule(rules.max);
      if (Number(value) > max) {
        errors.push(message || `${label} must be at most ${max}`);
      }
    }

    if (rules.strongPassword && !Helpers.isStrongPassword(String(value))) {
      errors.push(
        this.message(
          rules.strongPassword,
          `${label} must be at least 8 characters and include uppercase, lowercase, number, and special character`,
        ),
      );
    }

    if (rules.match !== undefined) {
      const matchError = this.matchError(label, value, rules.match, data);
      if (matchError) errors.push(matchError);
    }

    if (rules.in !== undefined) {
      const inError = this.inError(label, value, rules.in);
      if (inError) errors.push(inError);
    }

    if (rules.custom) {
      const customError = rules.custom(value, data);
      if (customError) errors.push(customError);
    }

    return errors;
  }

  static required(value: any, field = 'Field'): string | null {
    return Helpers.isEmpty(value) ? `${this.humanize(field)} is required` : null;
  }

  static email(value: any, field = 'email'): string | null {
    if (Helpers.isEmpty(value)) return null;
    return Helpers.isValidEmail(String(value))
      ? null
      : `${this.humanize(field)} must be a valid email`;
  }

  static minLength(value: any, min: number, field = 'Field'): string | null {
    if (Helpers.isEmpty(value)) return null;
    return String(value).length < min
      ? `${this.humanize(field)} must be at least ${min} characters`
      : null;
  }

  static maxLength(value: any, max: number, field = 'Field'): string | null {
    if (Helpers.isEmpty(value)) return null;
    return String(value).length > max
      ? `${this.humanize(field)} must be at most ${max} characters`
      : null;
  }

  static strongPassword(value: any, field = 'password'): string | null {
    if (Helpers.isEmpty(value)) return null;
    return Helpers.isStrongPassword(String(value))
      ? null
      : `${this.humanize(field)} must be at least 8 characters and include uppercase, lowercase, number, and special character`;
  }

  static pageLimit(
    limit: number,
    maxLimit: number = APP_CONSTANTS.MAX_PAGE_LIMIT,
  ): string | null {
    const value = Number(limit);

    if (Number.isNaN(value)) return 'Limit must be a number';
    if (value < 1) return 'Limit must be at least 1';
    if (value > maxLimit) return `Limit exceeded. Maximum limit is ${maxLimit}.`;

    return null;
  }

  /** Validate page limit and throw when invalid. */
  static assertPageLimit(
    limit: number,
    maxLimit: number = APP_CONSTANTS.MAX_PAGE_LIMIT,
  ): void {
    const error = this.pageLimit(limit, maxLimit);
    if (error) {
      throw new ValidationException([{ field: 'limit', errors: [error] }]);
    }
  }

  /**
   * Collect manual rule checks into a ValidationResult.
   *
   * @example
   * ValidationHelper.collect({
   *   email: [ValidationHelper.required(email, 'email'), ValidationHelper.email(email)],
   * });
   */
  static collect(fieldChecks: Record<string, Array<string | null | undefined>>): ValidationResult {
    const errors: Record<string, string[]> = {};

    for (const [field, checks] of Object.entries(fieldChecks)) {
      const fieldErrors = checks.filter((msg): msg is string => Boolean(msg));
      if (fieldErrors.length) {
        errors[field] = fieldErrors;
      }
    }

    return this.toResult(errors);
  }

  private static toResult(errors: Record<string, string[]>): ValidationResult {
    const errorList = Object.entries(errors).map(([field, fieldErrors]) => ({
      field,
      errors: fieldErrors,
    }));

    return {
      isValid: errorList.length === 0,
      errors,
      errorList,
    };
  }

  private static message(rule: boolean | string, fallback: string): string {
    return typeof rule === 'string' ? rule : fallback;
  }

  private static numberRule(rule: NumberRule): { value: number; message?: string } {
    return typeof rule === 'number' ? { value: rule } : rule;
  }

  private static isNumeric(value: any): boolean {
    return value !== '' && value !== null && !Number.isNaN(Number(value));
  }

  private static matchError(
    label: string,
    value: any,
    rule: MatchRule,
    data: Record<string, any>,
  ): string | null {
    const field = typeof rule === 'string' ? rule : rule.field;
    const customMessage = typeof rule === 'string' ? undefined : rule.message;

    if (value === data[field]) return null;

    return customMessage || `${label} must match ${this.humanize(field)}`;
  }

  private static inError(label: string, value: any, rule: InRule): string | null {
    const values = Array.isArray(rule) ? rule : rule.values;
    const customMessage = Array.isArray(rule) ? undefined : rule.message;

    if (values.includes(value)) return null;

    return customMessage || `${label} must be one of: ${values.join(', ')}`;
  }

  private static humanize(field: string): string {
    return field
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_-]+/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase())
      .trim();
  }
}

export default ValidationHelper;
