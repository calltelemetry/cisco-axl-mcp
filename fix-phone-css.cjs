const axlService = require('cisco-axl');

async function main() {
  const service = new axlService('192.168.125.10', 'ccmadmin', 'tek1links', '15.0');

  try {
    // List available CSS to find one with E911 partition
    const cssList = await service.executeOperation('listCss', {
      searchCriteria: { name: '%' },
      returnedTags: { name: true, description: true }
    });
    console.log('Available CSSs:', JSON.stringify(cssList, null, 2));

    // Get the CT-Internal-CSS (used by CTI Route Points) to see its partitions
    try {
      const ctCss = await service.executeOperation('getCss', {
        name: 'CT-Internal-CSS'
      });
      console.log('\nCT-Internal-CSS details:', JSON.stringify(ctCss, null, 2));
    } catch (e) {
      console.log('CT-Internal-CSS not found');
    }

  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
