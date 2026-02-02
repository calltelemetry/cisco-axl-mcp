const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Apply config to phone (soft reset)
    const result = await service.executeOperation('applyPhone', {
      name: 'SEP505C885DF37F'
    });
    console.log('Apply config result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
    // Try reset if apply doesn't work
    console.log('\nTrying doDeviceReset instead...');
    try {
      const resetResult = await service.executeOperation('doDeviceReset', {
        deviceName: 'SEP505C885DF37F',
        isHardReset: false
      });
      console.log('Reset result:', JSON.stringify(resetResult, null, 2));
    } catch (e2) {
      console.error('Reset error:', e2.message);
    }
  }
}

main();
