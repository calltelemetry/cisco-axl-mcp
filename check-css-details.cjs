const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // Get full phone config to see CSS
    const phone = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        name: true,
        callingSearchSpaceName: true
      }
    });
    console.log('Phone CSS:', JSON.stringify(phone, null, 2));

    // Get CSS details to see what partitions it includes
    if (phone.phone.callingSearchSpaceName?.value) {
      const css = await service.executeOperation('getCss', {
        name: phone.phone.callingSearchSpaceName.value
      });
      console.log('\nCSS details:', JSON.stringify(css, null, 2));
    } else {
      console.log('\nNo CSS configured on phone');
    }

    // Also check if there's a CSS on line 1 of the phone
    const phoneLines = await service.executeOperation('getPhone', {
      name: 'SEP505C885DF37F',
      returnedTags: {
        lines: {
          line: {
            index: true,
            dirn: { pattern: true },
            callForwardAll: true
          }
        }
      }
    });
    console.log('\nPhone line config:', JSON.stringify(phoneLines, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }
}

main();
