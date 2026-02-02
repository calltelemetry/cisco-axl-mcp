const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  console.log('=== 7975 PHONE AUDIT (DN 1000) ===\n');

  // Find phone with DN 1000
  const phones = await service.executeOperation('listPhone', {
    searchCriteria: { name: '%' },
    returnedTags: { name: true, model: true, lines: { line: { dirn: { pattern: true } } } }
  });

  const phone7975 = phones.phone?.find(p =>
    p.lines?.line?.some(l => l.dirn?.pattern === '1000')
  );

  if (!phone7975) {
    console.log('No phone found with DN 1000');
    return;
  }

  console.log('Found:', phone7975.name, '- Model:', phone7975.model);

  // Get full config
  const phone = await service.executeOperation('getPhone', {
    name: phone7975.name,
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

  console.log('\nCurrent Config:');
  console.log('  BIB:', phone.phone.builtInBridgeStatus);
  console.log('  Privacy:', phone.phone.callInfoPrivacyStatus);
  console.log('  CTI Control:', phone.phone.allowCtiControlFlag);
  console.log('  CSS:', phone.phone.callingSearchSpaceName?.value || 'NONE');

  const line = phone.phone.lines?.line?.find(l => l.dirn?.pattern === '1000');
  if (line) {
    console.log('\n  Line (DN 1000):');
    console.log('    Recording:', line.recordingFlag);
    console.log('    Media Source:', line.recordingMediaSource);
    console.log('    Recording Profile:', line.recordingProfileName?.value || 'NONE');
    console.log('    Monitoring CSS:', line.monitoringCssName?.value || 'NONE');
  }

  // Check what needs to be configured
  console.log('\n=== NEEDED CHANGES ===');
  const changes = [];

  if (phone.phone.builtInBridgeStatus !== 'On') {
    changes.push('Enable BIB (builtInBridgeStatus: On)');
  }
  if (phone.phone.callInfoPrivacyStatus !== 'Off') {
    changes.push('Disable Privacy (callInfoPrivacyStatus: Off)');
  }
  if (!line?.monitoringCssName?.value) {
    changes.push('Add Monitoring CSS (monitoringCssName: CT-Internal-CSS)');
  }
  if (!line?.recordingProfileName?.value) {
    changes.push('Add Recording Profile (recordingProfileName: CT-BIB-Recording)');
  }
  if (line?.recordingFlag !== 'Automatic Call Recording Enabled') {
    changes.push('Enable Recording (recordingFlag: Automatic Call Recording Enabled)');
  }

  if (changes.length === 0) {
    console.log('  All config looks good!');
  } else {
    changes.forEach(c => console.log('  - ' + c));
  }
}

main().catch(e => console.error('Error:', e.message));
