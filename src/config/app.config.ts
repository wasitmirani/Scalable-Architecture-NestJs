import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  environment: process.env.NODE_ENV || 'development',
//   parseInt(process.env.PORT, 10) 
  port:3000,
  apiPrefix: process.env.API_PREFIX || 'api',
  appName: process.env.APP_NAME || 'OMS Service',
}));