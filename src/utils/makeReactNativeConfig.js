/**
 * Copyright 2017-present, Callstack.
 * All rights reserved.
 *
 * @flow
 */
/* eslint-disable no-param-reassign */

const webpack = require('webpack');
const path = require('path');
const fs = require('fs');
const CaseSensitivePathsPlugin = require('case-sensitive-paths-webpack-plugin');
const haulProgressBar = require('./haulProgressBar');
const AssetResolver = require('../resolvers/AssetResolver');
const HasteResolver = require('../resolvers/HasteResolver');
const moduleResolve = require('../utils/resolveModule');
const getBabelConfig = require('./getBabelConfig');
const {
  extraPlatforms,
  extraProvidesModuleNodeModules,
} = require('./loadRnCli');

const PLATFORMS = ['ios', 'android', ...extraPlatforms()];

type ConfigOptions = {
  root: string,
  dev: boolean,
};

type WebpackPlugin = {
  apply: (typeof webpack) => void,
};

type WebpackEntry = string | Array<string> | Object;

type WebpackConfig = {
  entry: WebpackEntry,
  output: {
    path: string,
    filename: string,
  },
  name?: string,
  plugins: WebpackPlugin[],
  optimization: {
    minimize: boolean,
    namedModules: boolean,
    concatenateModules: boolean,
  },
};

type WebpackConfigFactory =
  | ((ConfigOptions, WebpackConfig) => WebpackConfig)
  | WebpackConfig;

/**
 * Returns default config based on environment
 */
const getDefaultConfig = ({
  platform,
  root,
  dev,
  minify,
  bundle,
  port,
}): WebpackConfig => {
  // Getting Minor version
  const platformProgressBar = haulProgressBar(platform);
  return {
    mode: dev ? 'development' : 'production',
    context: root,
    entry: [],
    output: {
      path: path.join(root, 'dist'),
      filename: `index.${platform}.bundle`,
      publicPath: `http://localhost:${port}/`,
    },
    module: {
      rules: [
        { parser: { requireEnsure: false } },
        {
          test: /\.js$/,
          exclude: /node_modules\/(?!react|@expo|pretty-format|haul|metro)/,
          use: [
            {
              loader: require.resolve('babel-loader'),
              options: Object.assign({}, getBabelConfig(root), {
                /**
                 * to improve the rebuild speeds
                 * This enables caching results in ./node_modules/.cache/babel-loader/
                 * This is a feature of `babel-loader` and not babel
                 */
                cacheDirectory: dev,
              }),
            },
          ],
        },
        {
          test: AssetResolver.test,
          use: {
            /**
             * Asset loader enables asset management based on image scale
             * This needs the AssetResolver plugin in resolver.plugins to work
             */
            loader: require.resolve('../loaders/assetLoader'),
            query: { platform, root, bundle },
          },
        },
      ],
    },
    plugins: [
      /**
       * MacOS has a case insensitive filesystem
       * This is needed so we can error on incorrect case
       */
      new CaseSensitivePathsPlugin(),

      new webpack.ProgressPlugin(perc => {
        platformProgressBar(platform, perc);
      }),

      new webpack.DefinePlugin({
        /**
         * Various libraries like React rely on `process.env.NODE_ENV`
         * to distinguish between production and development
         */
        'process.env': {
          NODE_ENV: dev ? '"development"' : '"production"',
        },
        __DEV__: dev,
      }),
      new webpack.LoaderOptionsPlugin({
        minimize: !!minify,
        debug: dev,
      }),
    ].concat(
      dev
        ? [
            new webpack.HotModuleReplacementPlugin(),
            new webpack.EvalSourceMapDevToolPlugin({
              module: true,
            }),
            new webpack.BannerPlugin({
              banner: `
                if (this && !this.self) { this.self = this; };
                ${fs
                  .readFileSync(
                    path.join(
                      __dirname,
                      '../../vendor/polyfills/Array.prototype.es6.js'
                    )
                  )
                  .toString()}
              `,
              raw: true,
            }),
          ]
        : [
            /**
               * By default, sourcemaps are only generated with *.js files
               * We need to use the plugin to configure *.bundle (Android, iOS - development)
               * and *.jsbundle (iOS - production) to emit sourcemap
               */
            new webpack.SourceMapDevToolPlugin({
              test: /\.(js|css|(js)?bundle)($|\?)/i,
              filename: '[file].map',
            }),
          ]
    ),
    resolve: {
      alias:
        process.env.NODE_ENV === 'production'
          ? {}
          : {
              /**
               * Latest `react-proxy` version does not contain try/catches from
               * commit 981815dca250373619138c9f5aadf12295cf1b3f.
               */
              'react-proxy': '@zamotany/react-proxy',
            },
      plugins: [
        /**
         * React Native uses a module system called Haste
         * We don't support it, but need to provide a compatibility layer
         */
        new HasteResolver({
          directories: extraPlatforms().includes(platform)
            ? [
                ...extraProvidesModuleNodeModules(),
                'react-native',
              ].map(provider => {
                return moduleResolve(root, provider);
              })
            : [moduleResolve(root, 'react-native')],
        }),
        /**
         * This is required by asset loader to resolve extra scales
         * It will resolve assets like image@1x.png when image.png is not present
         */
        new AssetResolver({ platform }),
      ],
      /**
       * Match what React Native packager supports
       * First entry takes precendece
       */
      mainFields: ['react-native', 'browser', 'main'],
      extensions: [`.${platform}.js`, '.native.js', '.js'],
    },
    optimization: {
      minimize: !!minify,
      namedModules: true,
      concatenateModules: true,
    },
    /**
     * Set target to webworker as it's closer to RN environment than `web`.
     */
    target: 'webworker',
  };
};

/**
 * Creates an array of configs based on changing `env` for every
 * platform and returns
 */
function makeReactNativeConfig(
  userWebpackConfig: WebpackConfigFactory,
  options: ConfigOptions
): [Array<WebpackConfig>, typeof PLATFORMS] {
  const configs = PLATFORMS.map(platform => {
    const env = Object.assign({}, options, { platform });
    const defaultWebpackConfig = getDefaultConfig(env);
    const polyfillPath = require.resolve('./polyfillEnvironment.js');

    const userConfig =
      typeof userWebpackConfig === 'function'
        ? userWebpackConfig(env, defaultWebpackConfig)
        : userWebpackConfig;

    const config = Object.assign({}, defaultWebpackConfig, userConfig, {
      entry: injectPolyfillIntoEntry(userConfig.entry, polyfillPath),
      name: platform,
    });

    return config;
  });

  return [configs, PLATFORMS];
}

/*
 * Takes user entries from webpack.haul.js,
 * change them to multi-point entries
 * and injects polyfills
 */
function injectPolyfillIntoEntry(
  userEntry: WebpackEntry,
  polyfillPath: string
): WebpackEntry {
  if (typeof userEntry === 'string') {
    return [polyfillPath, userEntry];
  }
  if (Array.isArray(userEntry)) {
    return [polyfillPath, ...userEntry];
  }
  if (typeof userEntry === 'object') {
    const chunkNames = Object.keys(userEntry);
    return chunkNames.reduce((entryObj: Object, name: string) => {
      // $FlowFixMe
      const chunk = userEntry[name];
      if (typeof chunk === 'string') {
        entryObj[name] = [polyfillPath, chunk];
        return entryObj;
      } else if (Array.isArray(chunk)) {
        entryObj[name] = [polyfillPath, ...chunk];
        return entryObj;
      }
      return chunk;
    }, {});
  }
  return userEntry;
}

module.exports = { makeReactNativeConfig, injectPolyfillIntoEntry };
