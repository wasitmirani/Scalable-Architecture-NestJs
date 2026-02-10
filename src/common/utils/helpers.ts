import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import * as crypto from 'crypto';

/**
 * Utility functions for common operations
 */
export class Helpers {
  /**
   * Generate a UUID v4 (random)
   */
  static generateUUID(): string {
    return uuidv4();
  }

  /**
   * Generate a UUID v5 (namespace-based)
   * @param name - Input name to generate UUID from
   * @param namespace - Namespace UUID (default: DNS namespace)
   */
  static generateNamedUUID(name: string, namespace: string = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'): string {
    return uuidv5(name, namespace);
  }

  /**
   * Generate a random username with prefix
   * @param prefix - Prefix for the username (default: 'user')
   * @param randomLength - Length of random suffix (default: 6)
   */
  static generateUsername(prefix: string = 'user', randomLength: number = 6): string {
    const randomString = crypto.randomBytes(Math.ceil(randomLength / 2)).toString('hex').slice(0, randomLength);
    return `${prefix}_${randomString}`;
  }

  /**
   * Generate a username from email address
   * @param email - Email address to generate username from
   */
  static generateUsernameFromEmail(email: string): string {
    const usernamePart = email.split('@')[0];
    // Remove special characters and add random suffix
    const cleanUsername = usernamePart.replace(/[^a-zA-Z0-9]/g, '');
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    return `${cleanUsername}_${randomSuffix}`.toLowerCase();
  }

  /**
   * Generate a random string with specified length
   * @param length - Length of the random string
   * @param charset - Character set to use (default: alphanumeric)
   */
  static generateRandomString(
    length: number = 10,
    charset: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  ): string {
    let result = '';
    const charsetLength = charset.length;
    
    for (let i = 0; i < length; i++) {
      result += charset.charAt(Math.floor(Math.random() * charsetLength));
    }
    
    return result;
  }

  /**
   * Generate a secure random token
   * @param length - Length of the token in bytes (default: 32)
   */
  static generateSecureToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Generate a numeric OTP code
   * @param length - Length of the OTP code (default: 6)
   */
  static generateOTP(length: number = 6): string {
    let otp = '';
    for (let i = 0; i < length; i++) {
      otp += Math.floor(Math.random() * 10).toString();
    }
    return otp;
  }

  /**
   * Hash a string using SHA-256
   * @param data - Data to hash
   */
  static hashString(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Generate a slug from a string
   * @param text - Text to convert to slug
   */
  static generateSlug(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Validate email format
   * @param email - Email to validate
   */
  static isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate password strength
   * @param password - Password to validate
   * @param minLength - Minimum length requirement (default: 8)
   */
  static isStrongPassword(password: string, minLength: number = 8): boolean {
    if (password.length < minLength) return false;
    
    const hasUpperCase = /[A-Z]/.test(password);
    const hasLowerCase = /[a-z]/.test(password);
    const hasNumbers = /\d/.test(password);
    const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
    
    return hasUpperCase && hasLowerCase && hasNumbers && hasSpecialChar;
  }

  /**
   * Format phone number to E.164 format
   * @param phoneNumber - Phone number to format
   * @param countryCode - Country code (default: '+1')
   */
  static formatPhoneNumber(phoneNumber: string, countryCode: string = '+1'): string {
    // Remove all non-digit characters
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // If the number already has country code, return as is
    if (cleaned.startsWith(countryCode.replace('+', ''))) {
      return `+${cleaned}`;
    }
    
    // Add country code if missing
    return `${countryCode}${cleaned}`;
  }

  /**
   * Generate a unique file name with extension
   * @param originalName - Original file name
   * @param prefix - Prefix for the file name (optional)
   */
  static generateFileName(originalName: string, prefix?: string): string {
    const extension = originalName.split('.').pop();
    const timestamp = Date.now();
    const randomString = this.generateRandomString(8);
    
    const baseName = prefix ? `${prefix}_${timestamp}_${randomString}` : `${timestamp}_${randomString}`;
    
    return extension ? `${baseName}.${extension}` : baseName;
  }


  /**
   * Delay execution for specified time
   * @param ms - Milliseconds to delay
   */
  static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  /**
   * Generate a unique order/reference ID
   * @param prefix - Prefix for the ID (default: 'ORD')
   */
  static generateReferenceId(prefix: string = 'ORD'): string {
    const timestamp = Date.now().toString();
    const randomPart = this.generateRandomString(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    return `${prefix}_${timestamp}_${randomPart}`;
  }

  /**
   * Check if value is empty (null, undefined, empty string, empty array, empty object)
   * @param value - Value to check
   */
  static isEmpty(value: any): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  }

  /**
   * Capitalize first letter of each word in a string
   * @param text - Text to capitalize
   */
  static capitalizeWords(text: string): string {
    return text.replace(/\b\w/g, char => char.toUpperCase());
  }

  /**
   * Generate a random color hex code
   */
  static generateRandomColor(): string {
    return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
  }

  /**
   * Mask sensitive data (emails, phone numbers, etc.)
   * @param data - Data to mask
   * @param type - Type of data to mask ('email', 'phone', 'creditCard')
   */
  static maskSensitiveData(data: string, type: 'email' | 'phone' | 'creditCard' = 'email'): string {
    switch (type) {
      case 'email':
        const [localPart, domain] = data.split('@');
        const maskedLocal = localPart.length > 2 
          ? localPart.substring(0, 2) + '*'.repeat(localPart.length - 2)
          : '*'.repeat(localPart.length);
        return `${maskedLocal}@${domain}`;
      
      case 'phone':
        const cleaned = data.replace(/\D/g, '');
        return cleaned.length > 4 
          ? '***-***-' + cleaned.substring(cleaned.length - 4)
          : '***-' + cleaned;
      
      case 'creditCard':
        return '****-****-****-' + data.slice(-4);
      
      default:
        return data;
    }
  }
}

// Default export for easier importing
export default Helpers;