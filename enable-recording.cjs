const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Update line to enable recording
    // Need to update the phone's line appearance to enable recording
    const result = await service.executeOperation('updatePhone', {
      name: 'SEP505C885DF37F',
      lines: {
        line: [
          {
            index: '1',
            dirn: {
              pattern: '1003',
              routePartitionName: ''  // May need to specify partition if used
            },
            recordingFlag: 'Automatic Call Recording Enabled'
          }
        ]
      }
    });
    console.log('Update result:', JSON.stringify(result, null, 2));

    // Verify the change
    const verifyResult = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        lines: {
          line: {
            index: true,
            dirn: { pattern: true },
            recordingFlag: true
          }
        }
      }
    });
    console.log('Verification:', JSON.stringify(verifyResult, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
