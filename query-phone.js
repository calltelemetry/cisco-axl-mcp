const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ct-jtapi-user', 'tek1links', '15.0');

  try {
    const result = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        builtInBridgeStatus: true,
        privacy: true,
        lines: {
          line: {
            index: true,
            dirn: { pattern: true },
            recordingFlag: true,
            recordingMediaSource: true,
            recordingProfileName: true
          }
        }
      }
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
