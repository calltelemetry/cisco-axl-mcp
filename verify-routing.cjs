const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Get the Recording Profile
    const profile = await service.executeOperation('getRecordingProfile', {
      name: 'CT-BIB-Recording'
    });
    console.log('Recording Profile:', JSON.stringify(profile, null, 2));

    // Get the CSS used by Recording Profile
    const css = await service.executeOperation('getCss', {
      name: 'CT-Internal-CSS'
    });
    console.log('\nCSS details:', JSON.stringify(css, null, 2));

    // Check if the CTI Route Point's DN 9000 is in E911 partition
    const ctiPort = await service.executeOperation('getCtiRoutePoint', {
      name: 'CT-JTAPI0001'
    });
    console.log('\nCTI Route Point line partition:',
      ctiPort?.ctiRoutePoint?.lines?.line?.[0]?.dirn?.routePartitionName);

    // Let's try updating the Recording Profile to use the actual DN instead of pattern
    console.log('\nUpdating Recording Profile recorderDestination to 9000...');
    const updateResult = await service.executeOperation('updateRecordingProfile', {
      name: 'CT-BIB-Recording',
      recorderDestination: '9000'  // Use exact DN instead of pattern
    });
    console.log('Update result:', updateResult);

    // Verify
    const updatedProfile = await service.executeOperation('getRecordingProfile', {
      name: 'CT-BIB-Recording'
    });
    console.log('\nUpdated Recording Profile:', JSON.stringify(updatedProfile, null, 2));

    // Apply config
    console.log('\nApplying config to phone...');
    await service.executeOperation('applyPhone', { name: 'SEP505C885DF37F' });
    console.log('Config applied');

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
