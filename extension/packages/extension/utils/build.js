// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = 'production';
process.env.NODE_ENV = 'production';
process.env.ASSET_PATH = '/';

var webpack = require('webpack'),
  path = require('path'),
  fs = require('fs'),
  config = require('../webpack.config'),
  ZipPlugin = require('zip-webpack-plugin');

delete config.chromeExtensionBoilerplate;

config.mode = 'production';

var packageInfo = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

// Recall: a dev build (test CA) gets its own zip name, so it never replaces the release zip.
var isDevBuild =
  Boolean((process.env.RECALL_DEV_CA_DER_B64 || '').trim()) || process.env.RECALL_DEV === '1';
var zipName = `${packageInfo.name}-${packageInfo.version}${isDevBuild ? '-dev' : ''}.zip`;

config.plugins = (config.plugins || []).concat(
  new ZipPlugin({
    filename: zipName,
    path: path.join(__dirname, '../', 'zip'),
  }),
);

webpack(config, function (err, stats) {
  if (err) {
    console.error('Webpack error:', err);
    process.exit(1);
  }

  if (stats.hasErrors()) {
    console.error('Build failed with errors:');
    const info = stats.toJson();
    console.error(info.errors.map((e) => e.message).join('\n\n'));
    process.exit(1);
  }

  if (stats.hasWarnings()) {
    console.warn('Build completed with warnings:');
    const info = stats.toJson();
    console.warn(info.warnings.map((w) => w.message).join('\n\n'));
  }

  console.log('Build completed successfully!');
  console.log(`Output: ${config.output.path}`);
  console.log(`Zip: ${path.join(__dirname, '../', 'zip', zipName)}`);
});
