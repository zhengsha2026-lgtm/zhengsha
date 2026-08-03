const app = require('./app');
const {
  PORT,
  LIFF_FORM_URL,
  LIFF_ID,
  hasLineCredentials,
  hasSupabaseCredentials,
  verifySupabaseConnection,
} = app.locals.runtimeConfig;

const isRunningOnVercel = Boolean(process.env.VERCEL);

if (!isRunningOnVercel && require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Campaign app is listening on port ${PORT}`);
    console.log(`Local homepage: http://localhost:${PORT}/liff.html`);
    console.log(`LINE credentials configured: ${hasLineCredentials}`);
    console.log(`Supabase credentials configured: ${hasSupabaseCredentials}`);
    console.log(`LIFF configured: ${Boolean(LIFF_ID)}`);
    console.log(`LIFF form URL: ${LIFF_FORM_URL}`);

    await verifySupabaseConnection();
  });
}

module.exports = app;
