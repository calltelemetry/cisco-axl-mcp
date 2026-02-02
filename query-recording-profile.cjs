const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Get full phone details including recording profile
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
    console.log('Phone config:', JSON.stringify(result, null, 2));

    // Also list available recording profiles
    const profiles = await service.executeOperation('listRecordingProfile', {
      searchCriteria: { name: '%' },
      returnedTags: { name: true, description: true }
    });
    console.log('\nAvailable Recording Profiles:', JSON.stringify(profiles, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
