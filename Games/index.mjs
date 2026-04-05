import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import jwt from 'jsonwebtoken';
import 
{ 
  DynamoDBDocumentClient, 
  QueryCommand, 
  DeleteCommand, 
  PutCommand, 
  UpdateCommand 
} from '@aws-sdk/lib-dynamodb';

// Table name CONST
const  TABLE_NAME = 'RMGPCollection2026';

// TODO: Move JWT_SECRET to environment variables of the lambda
const JWT_SECRET = process.env.JWT_SECRET;

// Initialize DynamoDB client
const client = new DynamoDBClient({
  region: 'us-east-1',
});
const docClient = DynamoDBDocumentClient.from(client);

// CORS - to allow HTTP methods, change Access-Control-Allow-Methods
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,DELETE,PUT,OPTIONS',
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

  // Handle preflight
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // GET - Fetch a single game by id, or all games if no id provided
  if (httpMethod === 'GET') {
    const id = event.pathParameters?.id;

    try {
      const params = {
        TableName: TABLE_NAME,
        KeyConditionExpression: id ? 'PK = :pk AND SK = :sk' : 'PK = :pk',
        ExpressionAttributeValues: id
          ? { ':pk': 'Game', ':sk': id }
          : { ':pk': 'Game' },
      };

      const data = await docClient.send(new QueryCommand(params));

      if (id && data.Items.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'Game not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          ...(id ? { item: data.Items[0] } : { count: data.Items.length, items: data.Items }),
        }),
      };
    } catch (error) {
      console.error('Error fetching data from DynamoDB:', error);

      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          message: 'Error fetching data from DynamoDB',
          error: error.message,
        }),
      };
    }
  }

  // DELETE - Delete a specific game record from DynamoDB
  if (httpMethod === 'DELETE') {
    const decodedEvent = verifyJWT(event);

    if (!decodedEvent) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Unauthorized' }),
      };
    }

    if (decodedEvent.role !== 'Admin') {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Forbidden: Admin access required' }),
      };
    }
    
    const id = event.pathParameters?.id;

    if (!id) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          success: false,
          message: 'Game ID is required',
        }),
      };
    }

    try {
        const params = {
            TableName: TABLE_NAME,
            Key: { PK: 'Game', SK: id },
            ConditionExpression: 'attribute_exists(SK)', // prevents silent no-op if item doesn't exist
        };

        await docClient.send(new DeleteCommand(params));

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                success: true,
                message: 'Game record deleted successfully',
            }),
        };
    } catch (error) {
        const notFound = error.name === 'ConditionalCheckFailedException';
        
        return {
            statusCode: notFound ? 404 : 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                success: false, 
                message: notFound ? 'Game not found' : error.message }),
        };
    }
  }

  // PUT /games - Create new game - must receive the full body including UUID (SK) from the front-end
  // PUT /games/{id} - Update existing game - can handle partial body updates
  if (httpMethod === 'PUT') {

    const decodedEvent = verifyJWT(event);
    
    if (!decodedEvent) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Unauthorized' }),
      };
    }

    if (decodedEvent.role !== 'Admin') {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'Forbidden: Admin access required' }),
      };
    }
    
    const id = event.pathParameters?.id;
    const body = JSON.parse(event.body || '{}');

    if (!id) {
      // CREATE — full body must include SK
      if (!body.SK) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ success: false, message: 'SK is required in the body to create a game' }),
        };
      }

      try {
        const item = { ...body, PK: 'Game' };
        await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

        return {
          statusCode: 201,
          headers: corsHeaders,
          body: JSON.stringify({ success: true, message: 'Game created successfully', item }),
        };
      } catch (error) {
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ success: false, message: error.message }),
        };
      }
    }

    // UPDATE — only provided fields are changed, existing fields untouched
    const updateFields = Object.keys(body).filter(k => k !== 'PK' && k !== 'SK');

    if (updateFields.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: 'No fields provided to update' }),
      };
    }

    try {
      const sanitize = k => k.replace(/[^a-zA-Z0-9_]/g, '_');
      const UpdateExpression = 'SET ' + updateFields.map(k => `#${sanitize(k)} = :${sanitize(k)}`).join(', ');
      const ExpressionAttributeNames = Object.fromEntries(updateFields.map(k => [`#${sanitize(k)}`, k]));
      const ExpressionAttributeValues = Object.fromEntries(updateFields.map(k => [`:${sanitize(k)}`, body[k]]));

      const result = await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: 'Game', SK: id },
        UpdateExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
        ConditionExpression: 'attribute_exists(SK)',
        ReturnValues: 'ALL_NEW',
      }));

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true, message: 'Game updated successfully', item: result.Attributes }),
      };
    } catch (error) {
      const notFound = error.name === 'ConditionalCheckFailedException';
      return {
        statusCode: notFound ? 404 : 500,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, message: notFound ? 'Game not found' : error.message }),
      };
    }
  }

  // Handle unsupported methods
  return {
    statusCode: 405,
    headers: corsHeaders,
    body: JSON.stringify({
      success: false,
      message: 'Method not allowed',
    }),
  };
};