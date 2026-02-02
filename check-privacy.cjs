const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Get phone with ALL relevant settings
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F'
    });
    console.log('Full Phone config:', JSON.stringify(phone, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
