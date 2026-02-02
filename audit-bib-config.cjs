const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  console.log('=== BIB CONFIGURATION AUDIT ===\n');

  try {
    // 1. Agent Phone Configuration
    console.log('1. AGENT PHONE: SEP505C885DF37F');
    console.log('─'.repeat(50));
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        builtInBridgeStatus: true,
        privacy: true,
        callInfoPrivacyStatus: true,
        callingSearchSpaceName: true,
        allowCtiControlFlag: true,
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
    console.log('  Built-In Bridge Status:', phone.phone.builtInBridgeStatus);
    console.log('  Privacy Status:', phone.phone.callInfoPrivacyStatus);
    console.log('  Allow CTI Control:', phone.phone.allowCtiControlFlag);
    console.log('  Calling Search Space:', phone.phone.callingSearchSpaceName?.value || 'NONE');

    const line = phone.phone.lines?.line?.[0];
    if (line) {
      console.log('\n  Line 1 (DN ' + line.dirn?.pattern + '):');
      console.log('    Recording Flag:', line.recordingFlag);
      console.log('    Recording Media Source:', line.recordingMediaSource);
      console.log('    Recording Profile:', line.recordingProfileName?.value || 'NONE');
      console.log('    Monitoring CSS:', line.monitoringCssName?.value || 'NONE ⚠️');
      console.log('    Partition:', line.dirn?.routePartitionName?.value || '<None>');
    }

    // 2. CTI Route Point Configuration
    console.log('\n\n2. CTI ROUTE POINT: CT-JTAPI0001 (DN 9000)');
    console.log('─'.repeat(50));
    const cti = await service.executeOperation('getCtiRoutePoint', {
      name: 'CT-JTAPI0001'
    });
    console.log('  Protocol:', cti.ctiRoutePoint.protocol);
    console.log('  Calling Search Space:', cti.ctiRoutePoint.callingSearchSpaceName?.value || 'NONE');

    const ctiLine = cti.ctiRoutePoint.lines?.line?.[0];
    if (ctiLine) {
      console.log('\n  Line 1 (DN ' + ctiLine.dirn?.pattern + '):');
      console.log('    Partition:', ctiLine.dirn?.routePartitionName?.value || '<None>');
    }

    // 3. Recording Profile
    console.log('\n\n3. RECORDING PROFILE');
    console.log('─'.repeat(50));
    try {
      const profile = await service.executeOperation('getRecordingProfile', {
        name: 'CT-BIB-Recording'
      });
      console.log('  Name:', profile.recordingProfile.name);
      console.log('  Recorder Destination:', profile.recordingProfile.recorderDestination);
      console.log('  Recording CSS:', profile.recordingProfile.recordingCssName?.value || 'NONE');
    } catch (e) {
      console.log('  No recording profile found');
    }

    // 4. CSS Analysis
    console.log('\n\n4. CSS ROUTING ANALYSIS');
    console.log('─'.repeat(50));
    const monitoringCss = line?.monitoringCssName?.value;
    if (monitoringCss) {
      const css = await service.executeOperation('getCss', { name: monitoringCss });
      console.log('  Monitoring CSS:', monitoringCss);
      console.log('  Partitions included:');
      css.css.members?.member?.forEach(m => {
        const isE911 = m.routePartitionName?.value === 'E911';
        console.log('    ' + m.index + '. ' + m.routePartitionName?.value + (isE911 ? ' ✓ (contains 9000)' : ''));
      });
    } else {
      console.log('  ⚠️ NO MONITORING CSS CONFIGURED - BIB cannot route to stream DN!');
    }

    // 5. Routing Check
    console.log('\n\n5. BIB ROUTING PATH CHECK');
    console.log('─'.repeat(50));
    const ctiPartition = ctiLine?.dirn?.routePartitionName?.value || '<None>';
    const hasE911InCss = monitoringCss ?
      (await service.executeOperation('getCss', { name: monitoringCss }))
        .css.members?.member?.some(m => m.routePartitionName?.value === ctiPartition) : false;

    console.log('  CTI DN 9000 is in partition:', ctiPartition);
    console.log('  Monitoring CSS includes ' + ctiPartition + ':', hasE911InCss ? '✓ YES' : '✗ NO');

    if (hasE911InCss) {
      console.log('\n  ✓ BIB should be able to route to DN 9000');
    } else {
      console.log('\n  ✗ BIB CANNOT route to DN 9000 - Monitoring CSS missing partition!');
    }

    // Summary
    console.log('\n\n=== SUMMARY ===');
    console.log('─'.repeat(50));
    const issues = [];
    if (phone.phone.builtInBridgeStatus !== 'On') issues.push('BIB not enabled on phone');
    if (phone.phone.callInfoPrivacyStatus !== 'Off') issues.push('Privacy not Off');
    if (!line?.monitoringCssName?.value) issues.push('No Monitoring CSS on line');
    if (!hasE911InCss) issues.push('Monitoring CSS cannot reach DN 9000');
    if (!line?.recordingProfileName?.value) issues.push('No Recording Profile on line');

    if (issues.length === 0) {
      console.log('  ✓ All BIB configuration appears correct');
    } else {
      console.log('  Issues found:');
      issues.forEach(i => console.log('    ✗ ' + i));
    }

  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
