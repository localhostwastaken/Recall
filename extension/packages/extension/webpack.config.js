var webpack = require('webpack'),
  path = require('path'),
  CopyWebpackPlugin = require('copy-webpack-plugin'),
  HtmlWebpackPlugin = require('html-webpack-plugin'),
  TerserPlugin = require('terser-webpack-plugin');
var { CleanWebpackPlugin } = require('clean-webpack-plugin');
var ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');
var ReactRefreshTypeScript = require('react-refresh-typescript');
var NodeProtocolResolvePlugin = require('./utils/NodeProtocolResolvePlugin');
var { recallManifest } = require('./utils/recallManifest');

const ASSET_PATH = process.env.ASSET_PATH || '/';

var fileExtensions = ['jpg', 'jpeg', 'png', 'gif', 'eot', 'otf', 'svg', 'ttf', 'woff', 'woff2'];

const isDevelopment = process.env.NODE_ENV !== 'production';

// Recall: TS source packages from the surrounding repo (packages/evidence, packages/net).
const RECALL_PACKAGES = path.resolve(__dirname, '../../../packages');
const RECALL_SOURCES = ['evidence', 'net'].map((p) => path.join(RECALL_PACKAGES, p, 'src'));

// Recall dev-CA build flag: base64 of ONE DER certificate (`base64 -i ca.der`). When set,
// the prover trusts only this CA (see src/recall/build.ts) and the build is a dev build.
const RECALL_DEV_CA_DER_B64 = (process.env.RECALL_DEV_CA_DER_B64 || '').replace(/\s+/g, '');
if (RECALL_DEV_CA_DER_B64) {
  const der = Buffer.from(RECALL_DEV_CA_DER_B64, 'base64');
  if (der.toString('base64') !== RECALL_DEV_CA_DER_B64 || der.length < 64 || der[0] !== 0x30) {
    throw new Error('RECALL_DEV_CA_DER_B64 must be the base64 of one DER certificate (not PEM)');
  }
}
const RECALL_DEV = Boolean(RECALL_DEV_CA_DER_B64) || process.env.RECALL_DEV === '1';

// Recall: RECALL_BUILD_DIR picks the output folder (default build/). The release build
// (scripts/build-release-extension.sh) goes to build-release/, so it never replaces the
// dev build that the local e2e tests load from build/.
const BUILD_DIR = path.resolve(__dirname, process.env.RECALL_BUILD_DIR || 'build');

var options = {
  mode: process.env.NODE_ENV || 'development',
  ignoreWarnings: [
    /Circular dependency between chunks with runtime/,
    /ResizeObserver loop completed with undelivered notifications/,
    /Should not import the named export/,
    /Sass @import rules are deprecated and will be removed in Dart Sass 3.0.0/,
    /Global built-in functions are deprecated and will be removed in Dart Sass 3.0.0./,
    /repetitive deprecation warnings omitted/,
    /Dart Sass 2.0.0/,
    /Critical dependency: the request of a dependency is an expression/,
  ],
  entry: {
    options: path.join(__dirname, 'src', 'entries', 'Options', 'index.tsx'),
    background: path.join(__dirname, 'src', 'entries', 'Background', 'index.ts'),
    offscreen: path.join(__dirname, 'src', 'entries', 'Offscreen', 'index.tsx'),
    popup: path.join(__dirname, 'src', 'entries', 'Popup', 'index.tsx'),
  },
  output: {
    filename: '[name].bundle.js',
    path: BUILD_DIR,
    clean: true,
    publicPath: ASSET_PATH,
    webassemblyModuleFilename: '[hash].wasm',
  },
  experiments: {
    asyncWebAssembly: true,
    syncWebAssembly: true,
  },
  module: {
    rules: [
      {
        // Recall: bare imports inside packages/*/src (viem, @arkiv-network/sdk,
        // @ethersphere/bee-js) resolve from this fork's node_modules first, not pnpm's.
        include: RECALL_SOURCES,
        resolve: {
          modules: [path.resolve(__dirname, '../../node_modules'), path.resolve(__dirname, 'node_modules'), 'node_modules'],
        },
      },
      {
        // Ignore .d.ts files from node_modules to prevent webpack parse errors
        test: /\.d\.ts$/,
        include: /node_modules/,
        use: 'null-loader',
      },
      {
        // Recall: viem (and its crypto deps) load secp256k1 with a dynamic import().
        // A split chunk is fetched with a <script> tag, which a service worker cannot
        // do, so signature recovery in the background would never resolve. Keep
        // these imports in the importing chunk.
        test: /[\\/]node_modules[\\/](viem|ox|@noble|@scure|abitype)[\\/]/,
        parser: {
          dynamicImportMode: 'eager',
        },
      },
      {
        // Prevent webpack from splitting QuickJS dynamic imports into separate
        // chunks that fail to load in Chrome extension offscreen documents.
        test: /[\\/]node_modules[\\/](@jitl[\\/]quickjs|quickjs-emscripten)/,
        parser: {
          dynamicImportMode: 'eager',
        },
      },
      {
        // look for .css or .scss files
        test: /\.(css|scss)$/,
        // in the `src` directory
        use: [
          {
            loader: 'style-loader',
          },
          {
            loader: 'css-loader',
            options: { importLoaders: 1 },
          },
          {
            loader: 'postcss-loader',
          },
          {
            loader: 'sass-loader',
            options: {
              sourceMap: true,
            },
          },
        ],
      },
      {
        test: new RegExp('.(' + fileExtensions.join('|') + ')$'),
        type: 'asset/resource',
        exclude: /node_modules/,
      },
      {
        test: /\.html$/,
        loader: 'html-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        use: [
          {
            loader: require.resolve('ts-loader'),
            options: {
              transpileOnly: isDevelopment,
              compiler: require.resolve('typescript'),
              // Recall: type errors are reported for this extension's own sources only;
              // packages/* are type-checked by the repo's TypeScript (5.7).
              reportFiles: ['src/**/*.{ts,tsx}'],
              ...(isDevelopment && {
                getCustomTransformers: () => ({
                  before: [ReactRefreshTypeScript()],
                }),
              }),
            },
          },
        ],
      },
      {
        test: /\.(js|jsx)$/,
        use: [{ loader: 'source-map-loader' }],
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    alias: {
      process: require.resolve('process/browser.js'),
      buffer: require.resolve('buffer/'),
      stream: require.resolve('stream-browserify'),
      path: require.resolve('path-browserify'),
      events: require.resolve('events/'),
      fs: path.resolve(__dirname, './src/node-fs-mock.js'),
      crypto: path.resolve(__dirname, './src/node-crypto-mock.js'),
      cluster: path.resolve(__dirname, './src/empty-module.js'),
      url: path.resolve(__dirname, './src/empty-module.js'),
      // Recall: one React for every bundle. The workspace root also holds an older
      // react (from upstream's lockfile) that hoisted packages such as lucide-react
      // would otherwise pick up, giving two Reacts and broken hooks.
      react: path.dirname(require.resolve('react/package.json')),
      'react-dom': path.dirname(require.resolve('react-dom/package.json')),
      '@recall/evidence': path.join(RECALL_PACKAGES, 'evidence', 'src'),
      '@recall/net': path.join(RECALL_PACKAGES, 'net', 'src'),
    },
    extensions: fileExtensions
      .map((extension) => '.' + extension)
      .concat(['.js', '.jsx', '.ts', '.tsx', '.css']),
    fallback: {
      fs: path.resolve(__dirname, './src/node-fs-mock.js'),
      path: require.resolve('path-browserify'),
      stream: require.resolve('stream-browserify'),
      crypto: path.resolve(__dirname, './src/node-crypto-mock.js'),
      buffer: require.resolve('buffer/'),
      process: require.resolve('process/browser.js'),
      util: require.resolve('util/'),
      assert: require.resolve('assert/'),
      url: path.resolve(__dirname, './src/empty-module.js'),
      events: require.resolve('events/'),
    },
  },
  plugins: [
    new NodeProtocolResolvePlugin({
      'node:fs': path.resolve(__dirname, './src/node-fs-mock.js'),
      'node:path': require.resolve('path-browserify'),
      'node:stream': require.resolve('stream-browserify'),
      'node:buffer': require.resolve('buffer/'),
      'node:crypto': path.resolve(__dirname, './src/node-crypto-mock.js'),
      'node:events': require.resolve('events/'),
      'node:url': path.resolve(__dirname, './src/node-url-mock.js'),
    }),
    isDevelopment && new ReactRefreshWebpackPlugin(),
    new CleanWebpackPlugin({ verbose: false }),
    new webpack.ProgressPlugin(),
    // expose and write the allowed env vars on the compiled bundle
    new webpack.EnvironmentPlugin(['NODE_ENV']),
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process',
    }),
    new webpack.DefinePlugin({
      'process.env': '{}',
      global: 'globalThis',
      __EXTENSION_VERSION__: JSON.stringify(require('./package.json').version),
      __RECALL_DEV__: JSON.stringify(RECALL_DEV),
      __RECALL_DEV_CA_DER_B64__: JSON.stringify(RECALL_DEV_CA_DER_B64),
      // R30: the default Arkiv access key of a release build, from the build's environment only.
      __RECALL_ARKIV_KEY__: JSON.stringify(RECALL_DEV ? '' : (process.env.ARKIV_ACCESS_KEY || '').trim()),
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/manifest.json',
          to: BUILD_DIR,
          force: true,
          transform: function (content, path) {
            // generates the manifest file using the package.json informations
            // Recall: a dev build is labelled "(dev)"; a release build accepts messages
            // from the GitHub Pages app only (utils/recallManifest.js).
            const manifest = recallManifest(JSON.parse(content.toString()), { dev: RECALL_DEV });
            return Buffer.from(
              JSON.stringify({
                description: process.env.npm_package_description,
                version: process.env.npm_package_version,
                ...manifest,
              }),
            );
          },
        },
      ],
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/assets/img/icon-128.png',
          to: BUILD_DIR,
          force: true,
        },
      ],
    }),
    new CopyWebpackPlugin({
      patterns: ['icon-16.png', 'icon-32.png', 'icon-34.png', 'icon-48.png'].map((name) => ({
        from: `src/assets/img/${name}`,
        to: BUILD_DIR,
        force: true,
      })),
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.dirname(require.resolve('tlsn-wasm/package.json')),
          to: BUILD_DIR,
          force: true,
          globOptions: {
            ignore: ['**/package.json', '**/README.md'],
          },
        },
      ],
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'entries', 'Offscreen', 'index.html'),
      filename: 'offscreen.html',
      chunks: ['offscreen'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'entries', 'Popup', 'index.html'),
      filename: 'popup.html',
      chunks: ['popup'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'entries', 'Options', 'index.html'),
      filename: 'options.html',
      chunks: ['options'],
      cache: false,
    }),
  ].filter(Boolean),
  infrastructureLogging: {
    level: 'info',
  },
};

if (isDevelopment) {
  options.devtool = 'cheap-module-source-map';
} else {
  options.optimization = {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
      }),
    ],
  };
}

module.exports = options;
