const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Update phone to use CT-Internal-CSS
    console.log('Updating phone SEP505C885DF37F to use CT-Internal-CSS...');

    const result = await service.executeOperation('updatePhone', {
      name: 'SEP505C885DF37F',
      callingSearchSpaceName: 'CT-Internal-CSS'
    });
    console.log('Update result:', JSON.stringify(result, null, 2));

    // Verify the change
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        callingSearchSpaceName: true
      }
    });
    console.log('\nVerified phone CSS:', JSON.stringify(phone, null, 2));

    // Apply config to phone
    console.log('\nApplying config to phone...');
    const applyResult = await service.executeOperation('applyPhone', {
      name: 'SEP505C885DF37F'
    });
    console.log('Apply result:', JSON.stringify(applyResult, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
