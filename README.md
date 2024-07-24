# aws-lambda-pdf
## Project Overview
The aws-lambda-pdf project is designed to generate PDFs from HTML content using AWS Lambda and Chromium. The generated PDF files are stored in an S3 bucket, and the application returns a signed URL for accessing the PDF file.

## Architecture
The project consists of the following main components:

- **API Gateway**: Provides an HTTP endpoint to trigger the Lambda function.
- **Lambda Function**: Generates PDF from HTML and stores it in an S3 bucket.
- **S3 Bucket**: Stores the generated PDF files with a lifecycle policy to delete files after 24 hours.
- **IAM Role**: Provides necessary permissions for the Lambda function to interact with S3.

## Prerequisites
- AWS CLI
- AWS SAM CLI
- Node.js
- npm

## Setup and Deployment
### 1. Clone the repository
```sh
git clone https://github.com/antoniowd/aws-lambda-pdf.git
cd aws-lambda-pdf
```
### 2. Install Dependencies
Navigate to the functions/html directory and install the required Node.js dependencies.
```sh
cd functions/html
npm install
```
### 3. Build and Deploy with SAM
Make sure you have the AWS SAM CLI installed and configured with your AWS credentials.

#### Build the application
```sh
sam build
```
#### Deploy the application
```sh
sam deploy --guided
```
Follow the prompts during the guided deployment to set parameters and review the changes before deploying.
#### Get the api key
```sh
aws apigateway get-api-keys --name-query MyApiKey --include-values --region YOUR_REGION
```
The deployment will generate an API Key. You need to get it from the AWS Console or use the above command:

### 4. Test the Endpoint
After deployment, you will get the API endpoint URL. Use the endpoint to generate a PDF from HTML.

**Example using `curl`**
```sh
curl -X POST -H "x-api-key: YOUR_API_KEY" \
-d '{"html":"<h1>Hello World!</h1>", "fileName": "myDoc.pdf", "inlinePdf: true }' \
"https://your-api-id.execute-api.your-region.amazonaws.com/prod/pdf/html"
```
Replace YOUR_API_KEY with your API key and add in the body of the request the HTML content you want to convert to PDF.
## Parameters for the endpoint
- **html** (required): A string containing the HTML content to be converted into the PDF. For example, <h1>Hello World!</h1> will create a PDF with a heading that says "Hello World!".
- **fileName** (optional, default: sample-document.pdf): The desired name of the generated PDF file. In the example, the PDF will be saved as myDoc.pdf.
- **inlinePdf** (optional, defaul: false): A boolean value indicating how the PDF should be displayed. If set to true, the PDF will be displayed inline (embedded within the page). If set to false or omitted, the PDF will prompt for download or open in a new tab depending on the browser's default behavior.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE.txt) file for details.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request for any changes.
