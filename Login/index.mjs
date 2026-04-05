import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const TABLE_NAME = 'RMGPUsers2026';
const JWT_SECRET = process.env.JWT_SECRET;
const API_BASE_URL = process.env.API_BASE_URL;
const SES_FROM = 'hello@rmgd.org';

const client = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);
const sesClient = new SESClient({ region: 'us-east-1' });

const sendVerificationEmail = async (toEmail, firstname, token) => {
  const verifyUrl = `${API_BASE_URL}/verify-email?token=${token}`;

  await sesClient.send(new SendEmailCommand({
    Source: SES_FROM,
    Destination: { ToAddresses: [toEmail] },
    Message: {
      Subject: { Data: 'Verify your RMGP account' },
      Body: {
        Html: {
          Data: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
              <h2>Welcome to RMGP, ${firstname}!</h2>
              <p>Thanks for registering. Please verify your email address by clicking the button below.</p>
              <p>This link expires in <strong>10 minutes</strong>.</p>
              <a href="${verifyUrl}"
                 style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;
                        text-decoration:none;border-radius:6px;font-weight:bold;margin:16px 0;">
                Verify Email
              </a>
              <p style="color:#888;font-size:12px;">
                If you did not create an account, you can safely ignore this email.
              </p>
            </div>
          `,
        },
        Text: {
          Data: `Welcome to RMGD, ${firstname}!\n\nVerify your email here (expires in 10 minutes):\n${verifyUrl}\n\nIf you did not create an account, ignore this email.`,
        },
      },
    },
  }));
};

const NAME_REGEX = /^[a-zA-Z]+$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
  'Content-Type': 'application/json',
};

const verifyJWT = (event) => {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
  } catch {
    return null;
  }
};

export const handler = async (event) => {
  const httpMethod = event.requestContext?.http?.method;
  const path = event.rawPath;

  if (httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // ── POST /register ─────────────────────────────────────────────
  if (httpMethod === 'POST' && path === '/register') {
    const body = JSON.parse(event.body || '{}');
    const { firstname, lastname, email, password } = body;

    if (!firstname || !lastname || !email || !password) {
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'All fields are required: firstname, lastname, email, password' }) };
    }
    if (!NAME_REGEX.test(firstname) || !NAME_REGEX.test(lastname)) {
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'First and last name can only contain letters' }) };
    }
    if (!EMAIL_REGEX.test(email)) {
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Invalid email address' }) };
    }

    try {
      const existing = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': 'User', ':sk': email },
      }));

      if (existing.Items.length > 0) {
        const existingUser = existing.Items[0];
        if (!existingUser.emailVerified) {
          return { statusCode: 409, headers: corsHeaders,
            body: JSON.stringify({ success: false, message: 'An account with this email exists but is not yet verified. Please check your email or use the resend verification endpoint.' }) };
        }
        return { statusCode: 409, headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'An account with this email already exists' }) };
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const newUser = {
        PK: 'User',
        SK: email,
        firstname,
        lastname,
        email,
        role: 'User',
        passwordHash,
        emailVerified: false,
        createdAt: new Date().toISOString(),
      };
      await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: newUser }));

      const verificationToken = jwt.sign(
        { email, purpose: 'email-verification' },
        JWT_SECRET,
        { expiresIn: '10m' }
      );

      await sendVerificationEmail(email, firstname, verificationToken);

      const { passwordHash: _, ...userResponse } = newUser;
      return { statusCode: 201, headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          message: 'User created successfully. A verification email has been sent.',
          user: userResponse,
        }) };
    } catch (error) {
      return { statusCode: 500, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Internal server error', error: error.message }) };
    }
  }

  // ── POST /login ────────────────────────────────────────────────
  if (httpMethod === 'POST' && path === '/login') {
    const body = JSON.parse(event.body || '{}');
    const { email, password } = body;

    if (!email || !password) {
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Email and password are required' }) };
    }

    try {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': 'User', ':sk': email },
      }));

      const user = result.Items[0];
      const passwordMatch = user && await bcrypt.compare(password, user.passwordHash);

      if (!passwordMatch) {
        return { statusCode: 401, headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'Invalid email or password' }) };
      }

      if (!user.emailVerified) {
        return { statusCode: 403, headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'Email not verified. Please verify your email before logging in.' }) };
      }

      const token = jwt.sign({ email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
      const { passwordHash: _, ...userResponse } = user;

      return { statusCode: 200, headers: corsHeaders,
        body: JSON.stringify({ success: true, token, user: userResponse }) };
    } catch (error) {
      return { statusCode: 500, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Internal server error', error: error.message }) };
    }
  }

  // ── GET /verify-email ──────────────────────────────────────────
  if (httpMethod === 'GET' && path === '/verify-email') {
    const token = event.queryStringParameters?.token;

    if (!token) {
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Verification token is required' }) };
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      const expired = error.name === 'TokenExpiredError';
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: expired ? 'Verification link has expired. Please register again.' : 'Invalid verification token' }) };
    }

    if (decoded.purpose !== 'email-verification') {
      return { statusCode: 400, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Invalid token purpose' }) };
    }

    try {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': 'User', ':sk': decoded.email },
      }));

      const user = result.Items[0];
      if (!user) {
        return { statusCode: 404, headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'User not found' }) };
      }
      if (user.emailVerified) {
        return { statusCode: 200, headers: corsHeaders,
          body: JSON.stringify({ success: true, message: 'Email is already verified. You can log in.' }) };
      }

      await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: 'User', SK: decoded.email },
        UpdateExpression: 'SET emailVerified = :verified, verifiedAt = :verifiedAt',
        ExpressionAttributeValues: {
          ':verified': true,
          ':verifiedAt': new Date().toISOString(),
        },
      }));

      return { statusCode: 200, headers: corsHeaders,
        body: JSON.stringify({ success: true, message: 'Email verified successfully. You can now log in.' }) };
    } catch (error) {
      return { statusCode: 500, headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Internal server error', error: error.message }) };
    }
  }
};