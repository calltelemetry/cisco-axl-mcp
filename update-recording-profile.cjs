const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Get the recording profile details first
    const profile = await service.executeOperation('getRecordingProfile', {
      name: 'CT-BIB-Recording'
    });
    console.log('Current Recording Profile:', JSON.stringify(profile, null, 2));

    // Update Recording Profile with CSS that includes E911 partition
    console.log('\nUpdating Recording Profile with CT-Internal-CSS...');
    const updateResult = await service.executeOperation('updateRecordingProfile', {
      name: 'CT-BIB-Recording',
      recordingCssName: 'CT-Internal-CSS'  // This CSS includes E911 partition
    });
    console.log('Update result:', updateResult);

    // Verify update
    const updatedProfile = await service.executeOperation('getRecordingProfile', {
      name: 'CT-BIB-Recording'
    });
    console.log('\nUpdated Recording Profile:', JSON.stringify(updatedProfile, null, 2));

    // Apply config to phone again
    console.log('\nApplying config to phone...');
    const applyResult = await service.executeOperation('applyPhone', {
      name: 'SEP505C885DF37F'
    });
    console.log('Apply result:', applyResult);

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
