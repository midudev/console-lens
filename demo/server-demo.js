// HTTP server demo. With the browser injector loader active, the served HTML
// gets a tiny client that streams browser console.log calls to Console Lens.
//
//   node --require ../injector/loader.js server-demo.js
//   open http://localhost:3000
const http = require('node:http');

const html = `<!doctype html>
<html>
  <head><title>Console Lens browser demo</title></head>
  <body>
    <h1>Open the console and watch your editor</h1>
    <script>
      let n = 0;
      setInterval(() => {
        n++;
        console.log('browser tick', n, { even: n % 2 === 0 });
      }, 1000);
    </script>
  </body>
</html>`;

http
  .createServer((req, res) => {
    console.log('request', req.method, req.url);
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  })
  .listen(3000, () => console.log('server-demo on http://localhost:3000'));
