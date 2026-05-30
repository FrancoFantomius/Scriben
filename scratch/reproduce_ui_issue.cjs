const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  page.on('console', msg => {
      // ignore verbose pouchdb logs if any, but log others
      console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', error => console.log(`[Browser Error] ${error}`));

  const url = 'http://localhost:5173/dashboard.html';
  console.log(`Navigating to ${url}...`);
  await page.goto(url);
  await page.waitForTimeout(2000);

  console.log('Clicking "New Document"...');
  await page.click('text=New Document');
  await page.waitForTimeout(2000);

  console.log('Typing in editor...');
  // The editor pages have class 'page', contenteditable.
  const page1 = page.locator('.page').first();
  await page1.fill('This is a test document content. Testing if it persists.');
  await page.waitForTimeout(2500); // Wait for debounce and PouchDB save

  console.log('Going back to dashboard...');
  await page.click('button#back-btn');
  await page.waitForTimeout(2000);

  console.log('Reopening the document...');
  // Find the first document card
  const docCards = page.locator('.document-card');
  if (await docCards.count() > 0) {
    await docCards.first().click();
    await page.waitForTimeout(2000);
    
    const content = await page.locator('.page').first().textContent();
    console.log(`[Document Content]: "${content.trim()}"`);
    
    if (content.trim() === "") {
        console.log("ISSUE: Document is blank!");
    } else {
        console.log("Document loaded correctly.");
    }
  } else {
    console.log('No documents found in dashboard!');
  }

  await browser.close();
})();
