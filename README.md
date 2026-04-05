# serverless-backend-aws

AWS Lambda functions that power the v2 backend of the RMGP website. Each directory is a self-contained Lambda function with its own dependencies and is deployed independently.

---

## Directory Overview

### `Login/`

Handles user identity for the RMGP platform. A single Lambda function exposes three routes:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Creates a new user account, hashes the password with bcrypt, and sends a verification email via AWS SES. |
| `POST` | `/login` | Validates credentials and returns a signed JWT (8-hour expiry) on success. Rejects unverified accounts. |
| `GET` | `/verify-email` | Accepts a short-lived JWT (10-minute expiry) from the verification email link and marks the account as verified in DynamoDB. |

**DynamoDB table:** `RMGPUsers2026`  
**Environment variables required:** `JWT_SECRET`, `API_BASE_URL`  
**Dependencies:** `bcryptjs`, `jsonwebtoken`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-ses`

---

### `Collections/`

Manages game collections displayed on the RMGP website. Reads are public; writes require an Admin JWT.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/collections` | Returns all collections. |
| `GET` | `/collections/{id}` | Returns a single collection by ID. |
| `PUT` | `/collections` | Creates a new collection (Admin only). Body must include `SK` (UUID). |
| `PUT` | `/collections/{id}` | Partially updates an existing collection (Admin only). |
| `DELETE` | `/collections/{id}` | Deletes a collection by ID (Admin only). |

**DynamoDB table:** `RMGPCollection2026`  
**Environment variables required:** `JWT_SECRET`  
**Dependencies:** `jsonwebtoken`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`

---

### `Games/`

Manages individual game records. Mirrors the same CRUD pattern as `Collections/`, operating on `Game` partition keys within the same DynamoDB table.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/games` | Returns all games. |
| `GET` | `/games/{id}` | Returns a single game by ID. |
| `PUT` | `/games` | Creates a new game record (Admin only). Body must include `SK` (UUID). |
| `PUT` | `/games/{id}` | Partially updates an existing game record (Admin only). |
| `DELETE` | `/games/{id}` | Deletes a game record by ID (Admin only). |

**DynamoDB table:** `RMGPCollection2026`  
**Environment variables required:** `JWT_SECRET`  
**Dependencies:** `jsonwebtoken`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`

---

## Deploying to AWS Lambda

CI/CD is not set up yet. Deploy each function manually by zipping the folder and uploading it directly to the corresponding Lambda function in the AWS Console.

### Steps (repeat for each function)

1. **Install dependencies** inside the function directory so they are bundled into the zip:

   ```bash
   cd Login      # or Collections / Games
   npm install
   ```

2. **Zip the entire folder contents** — zip the *contents* of the directory, not the directory itself. The `index.mjs` file must be at the root of the zip, not nested inside a folder:

   ```bash
   # From inside the Login/ directory
   zip -r ../login.zip .

   # From inside the Collections/ directory
   zip -r ../collections.zip .

   # From inside the Games/ directory
   zip -r ../games.zip .
   ```

3. **Upload to AWS Lambda:**
   - Open the [AWS Lambda Console](https://console.aws.amazon.com/lambda)
   - Select the target Lambda function
   - Under **Code source**, click **Upload from** → **.zip file**
   - Upload the corresponding `.zip` file
   - Click **Save**

4. **Set environment variables** in the Lambda function's **Configuration → Environment variables** tab:
   - `JWT_SECRET` — shared secret used to sign and verify JWTs (required by all three functions)
   - `API_BASE_URL` — the base URL of the API Gateway (required by `Login/` for email verification links)

> **Note:** The `.zip` files at the repo root (`login.zip`, `collections.zip`, `games.zip`) are pre-built snapshots and can be used for a quick upload, but always rebuild from source after any code or dependency changes.
