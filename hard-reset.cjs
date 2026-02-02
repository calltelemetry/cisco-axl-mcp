const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    console.log('Performing HARD reset on phone SEP505C885DF37F...');

    // Try doDeviceReset with isHardReset=true
    const result = await service.executeOperation('doDeviceReset', {
      deviceName: 'SEP505C885DF37F',
      isHardReset: true
    });
    console.log('Hard reset result:', JSON.stringify(result, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);

    // Try restartPhone as alternative
    console.log('\nTrying restartPhone instead...');
    try {
      const result2 = await service.executeOperation('restartPhone', {
        name: 'SEP505C885DF37F'
      });
      console.log('Restart result:', JSON.stringify(result2, null, 2));
    } catch (e2) {
      console.error('Restart error:', e2.message);
    }
  }
}

main();
