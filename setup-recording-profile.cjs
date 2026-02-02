const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Create a Recording Profile
    // The recorder destination can be a Route Pattern that matches CTI ports
    console.log('Creating Recording Profile...');

    const createResult = await service.executeOperation('addRecordingProfile', {
      recordingProfile: {
        name: 'CT-BIB-Recording',
        description: 'CallTelemetry BIB Recording Profile',
        // recordingCssName is optional - uses Default if not specified
        recorderDestination: '900X'  // Pattern to match CTI ports 9000-9004
      }
    });
    console.log('Create result:', JSON.stringify(createResult, null, 2));

    // Assign the recording profile to the phone's line
    console.log('\nAssigning recording profile to phone line...');
    const updateResult = await service.executeOperation('updatePhone', {
      name: 'SEP505C885DF37F',
      lines: {
        line: [{
          index: '1',
          dirn: {
            pattern: '1003',
            routePartitionName: ''
          },
          recordingProfileName: 'CT-BIB-Recording'
        }]
      }
    });
    console.log('Update result:', JSON.stringify(updateResult, null, 2));

    // Verify the change
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
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
    console.log('\nPhone config after update:', JSON.stringify(phone, null, 2));

    // Apply config to phone
    console.log('\nApplying config to phone...');
    const applyResult = await service.executeOperation('applyPhone', {
      name: 'SEP505C885DF37F'
    });
    console.log('Apply result:', applyResult);

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
    if (e.response?.data) console.error('Response:', e.response.data);
  }
}

main();
