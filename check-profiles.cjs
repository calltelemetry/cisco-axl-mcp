const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // List all recording profiles
    const profiles = await service.executeOperation('listRecordingProfile', {
      searchCriteria: { name: '%' },
      returnedTags: { name: true, description: true, recordingCssName: true }
    });
    console.log('Recording Profiles:', JSON.stringify(profiles, null, 2));

    // Also check phone privacy setting
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        privacy: true,
        builtInBridgeStatus: true,
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
    console.log('\nPhone config with privacy:', JSON.stringify(phone, null, 2));

    // Check if there's a SIP profile we might need
    const sipProfiles = await service.executeOperation('listSipProfile', {
      searchCriteria: { name: '%' },
      returnedTags: { name: true }
    });
    console.log('\nSIP Profiles:', JSON.stringify(sipProfiles, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
