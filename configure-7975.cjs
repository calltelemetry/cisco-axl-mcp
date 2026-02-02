const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  const phoneName = 'SEP0022905C7710';
  console.log('Configuring 7975 phone for BIB:', phoneName);

  try {
    // Update phone with BIB config
    console.log('\n1. Updating phone line with recording settings...');
    const updateResult = await service.executeOperation('updatePhone', {
      name: phoneName,
      callingSearchSpaceName: 'CT-Internal-CSS',  // Add CSS for routing
      lines: {
        line: [{
          index: '1',
          dirn: {
            pattern: '1000',
            routePartitionName: ''
          },
          recordingFlag: 'Automatic Call Recording Enabled',
          recordingMediaSource: 'Phone Preferred',
          recordingProfileName: 'CT-BIB-Recording',
          monitoringCssName: 'CT-Internal-CSS'
        }]
      }
    });
    console.log('   Update result:', updateResult);

    // Verify changes
    console.log('\n2. Verifying configuration...');
    const phone = await service.executeOperation('getPhone', {
      name: phoneName,
      returnedTags: {
        name: true,
        builtInBridgeStatus: true,
        callInfoPrivacyStatus: true,
        callingSearchSpaceName: true,
        lines: {
          line: {
            dirn: { pattern: true },
            recordingFlag: true,
            recordingProfileName: true,
            monitoringCssName: true
          }
        }
      }
    });

    console.log('   BIB:', phone.phone.builtInBridgeStatus);
    console.log('   Privacy:', phone.phone.callInfoPrivacyStatus);
    console.log('   CSS:', phone.phone.callingSearchSpaceName?.value);
    const line = phone.phone.lines?.line?.[0];
    console.log('   Recording:', line?.recordingFlag);
    console.log('   Recording Profile:', line?.recordingProfileName?.value);
    console.log('   Monitoring CSS:', line?.monitoringCssName?.value);

    // Apply config
    console.log('\n3. Applying config to phone...');
    await service.executeOperation('applyPhone', { name: phoneName });
    console.log('   Done!');

    console.log('\n=== 7975 READY FOR BIB TESTING ===');

  } catch(e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
