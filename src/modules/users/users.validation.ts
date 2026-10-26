import { ValidationSchema } from '../../common/utils/validation.helper';

/** Field rules for creating / registering a user */
export const CREATE_USER_SCHEMA: ValidationSchema = {
  name: { required: true, minLength: 2, maxLength: 255 },
  email: { required: true, email: true, maxLength: 255 },
  password: { required: true, strongPassword: true, maxLength: 255 },
};
