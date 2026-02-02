const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // First, list existing recording profiles
    const profiles = await service.executeOperation('listRecordingProfile', {
      searchCriteria: { name: '%' },
      returnedTags: { name: true, description: true, recordingCssName: true, recorderDestination: true }
    });
    console.log('Existing Recording Profiles:', JSON.stringify(profiles, null, 2));

    // If no profiles exist, we need to create one
    // A Recording Profile needs:
    // - Name
    // - RecorderDestination (the SIP trunk/route to the recording server, OR can use Built-in Bridge)

    // Check if we have any SIP trunks for recording
    const sipTrunks = await service.executeOperation('listSipTrunk', {
      searchCriteria: { name: '%' },
      returnedTags: { name: true, description: true }
    });
    console.log('\nSIP Trunks:', JSON.stringify(sipTrunks, null, 2));

    // Check Route Patterns for recording destination
    const routePatterns = await service.executeOperation('listRoutePattern', {
      searchCriteria: { pattern: '9%' },
      returnedTags: { pattern: true, description: true }
    });
    console.log('\nRoute Patterns starting with 9:', JSON.stringify(routePatterns, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
