//@ts-check

"use strict";

const path = require("path");
const copyPlugin = require("copy-webpack-plugin");

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const baseConfig = {
  mode: "none", // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
  externals: {
    vscode: "commonjs vscode" // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    extensions: [".ts", ".js", ".css"]
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log" // enables logging required for problem matchers
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader" }]
      },
      // Allow importing CSS modules:
      {
        test: /\.css$/,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: {
              importLoaders: 1,
              modules: true
            }
          }
        ]
      },
      {}
    ]
  }
};

/** @type WebpackConfig */
const extensionConfig = {
  ...baseConfig,
  target: "node", // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
  entry: "./src/extension.ts", // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  ignoreWarnings: [
    {
      module: /node_modules[\\/]express[\\/]lib[\\/]view\.js/,
      message: /Critical dependency: the request of a dependency is an expression/
    }
  ],
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2"
  }
};

// Config for webview source code (to be run in a web-based context)
/** @type WebpackConfig */
const webviewConfig = {
  ...baseConfig,
  target: ["web", "es2020"],
  entry: "./src/webview/main.ts",
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "webview.js",
    libraryTarget: "module",
    chunkFormat: "module"
  },
  plugins: [
    new copyPlugin({
      patterns: [
        {
          from: "./src/webview/style.css",
          to: path.resolve(__dirname, "dist")
        },
        {
          from: "./src/backend/SCM_API.sdp",
          to: path.resolve(__dirname, "dist")
        },
        {
          from: "./resources/instructions",
          to: path.resolve(__dirname, "dist/instructions")
        }
      ]
    })
  ]
};
module.exports = [extensionConfig, webviewConfig];
