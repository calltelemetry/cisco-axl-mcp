const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  console.log('=== 7975 PHONE AUDIT (DN 1000) ===\n');

  // Try getting phone by name pattern that might be 7975
  // First list all phones to find the one with DN 1000
  try {
    // Get lines with DN 1000
    const lines = await service.executeOperation('listLine', {
      searchCriteria: { pattern: '1000' },
      returnedTags: { pattern: true, routePartitionName: true }
    });
    console.log('Lines with pattern 1000:', JSON.stringify(lines, null, 2));
  } catch(e) {
    console.log('Error listing lines:', e.message);
  }

  // Try to get phones that might have 1000
  // Based on logs we saw SEP0022905C7710 has DN 1000
  const phoneName = 'SEP0022905C7710';
  console.log('\nChecking phone:', phoneName);

  try {
    const phone = await service.executeOperation('getPhone', {
      name: phoneName,
      returnedTags: {
        name: true,
        model: true,
        builtInBridgeStatus: true,
        callInfoPrivacyStatus: true,
        allowCtiControlFlag: true,
        callingSearchSpaceName: true,
        lines: {
          line: {
            index: true,
            dirn: { pattern: true, routePartitionName: true },
            recordingFlag: true,
            recordingMediaSource: true,
            recordingProfileName: true,
            monitoringCssName: true
          }
        }
      }
    });

    console.log('Model:', phone.phone.model);
    console.log('\nCurrent Config:');
    console.log('  BIB:', phone.phone.builtInBridgeStatus);
    console.log('  Privacy:', phone.phone.callInfoPrivacyStatus);
    console.log('  CTI Control:', phone.phone.allowCtiControlFlag);
    console.log('  CSS:', phone.phone.callingSearchSpaceName?.value || 'NONE');

    const line = phone.phone.lines?.line?.[0];
    if (line) {
      console.log('\n  Line (DN ' + line.dirn?.pattern + '):');
      console.log('    Recording:', line.recordingFlag);
      console.log('    Media Source:', line.recordingMediaSource);
      console.log('    Recording Profile:', line.recordingProfileName?.value || 'NONE');
      console.log('    Monitoring CSS:', line.monitoringCssName?.value || 'NONE');
    }
  } catch(e) {
    console.log('Error getting phone:', e.message);
  }
}

main().catch(e => console.error('Error:', e.message));
