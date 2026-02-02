const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Get CTI port 1 details (includes DN 9000)
    const ctiPort = await service.executeOperation('getCtiRoutePoint', {
      name: 'CT-JTAPI0001'
    });
    console.log('CTI Port 1 config:', JSON.stringify(ctiPort, null, 2));

  } catch (e) {
    console.log('getCtiRoutePoint failed:', e.message);

    // Try getPhone for CTI port (they can be CTI Ports or Route Points)
    try {
      const port = await service.executeOperation('getPhone', {
        name: 'CT-JTAPI0001'
      });
      console.log('CTI device config:', JSON.stringify(port, null, 2));
    } catch (e2) {
      console.error('getPhone error:', e2.message);
    }
  }

  // Also check phone's CSS to ensure it can route to 9000
  try {
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        callingSearchSpaceName: true,
        lines: {
          line: {
            index: true,
            dirn: { pattern: true, routePartitionName: true },
            e164AltNum: true,
            aarNeighborhoodName: true,
            callForwardAll: true,
            recordingFlag: true,
            recordingProfileName: true
          }
        }
      }
    });
    console.log('\nPhone CSS/line config:', JSON.stringify(phone, null, 2));
  } catch (e) {
    console.error('Error getting phone CSS:', e.message);
  }

  // List lines to see partition of 9000
  try {
    const lines = await service.executeOperation('listLine', {
      searchCriteria: { pattern: '9000' },
      returnedTags: { pattern: true, routePartitionName: true, description: true }
    });
    console.log('\nLines matching 9000:', JSON.stringify(lines, null, 2));
  } catch (e) {
    console.error('Error listing lines:', e.message);
  }
}

main();
