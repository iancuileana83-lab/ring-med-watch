require('dotenv').config();
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
(async () => {
  try {
    const command = new InvokeModelCommand({
      modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 50, messages: [{ role: 'user', content: 'say hi' }] })
    });
    const response = await bedrock.send(command);
    console.log('SUCCESS');
  } catch (err) {
    console.log('NAME:', err.name);
    console.log('MESSAGE:', err.message);
    console.log('METADATA:', JSON.stringify(err.$metadata));
  }
})();
