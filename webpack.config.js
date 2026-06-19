//@ts-check

"use strict";

const path = require("path");
const copyPlugin = require("copy-webpack-plugin");

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  mode: "none",
  target: "node",
  externals: {
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".js", ".css"]
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log"
  },
  ignoreWarnings: [
    {
      module: /node_modules[\\/]express[\\/]lib[\\/]view\.js/,
      message: /Critical dependency: the request of a dependency is an expression/
    }
  ],
  entry: "./src/extension.ts",
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader", options: { transpileOnly: true } }]
      },
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
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2"
  }
};

/** @type WebpackConfig */
const webviewConfig = {
  mode: "none",
  target: ["web", "es2020"],
  externals: {
    vscode: "commonjs vscode"
  },
  resolve: {
    extensions: [".ts", ".js", ".css"]
  },
  devtool: "nosources-source-map",
  entry: "./src/webview/main.ts",
  experiments: { outputModule: true },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: "ts-loader", options: { transpileOnly: true } }]
      },
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
  },
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

/** @type WebpackConfig */
const serverConfig = {
  mode: "none",
  target: "node",
  externals: {
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".js", ".css"]
  },
  devtool: "nosources-source-map",
  infrastructureLogging: {
    level: "log"
  },
  entry: "./src/lsp/server/server.ts",
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{
          loader: "ts-loader",
          options: {
            configFile: path.resolve(__dirname, "tsconfig.server.json"),
            transpileOnly: true
          }
        }]
      },
      {}
    ]
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "ssl-language-server.js",
    libraryTarget: "commonjs2"
  }
};

module.exports = [extensionConfig, webviewConfig, serverConfig];
