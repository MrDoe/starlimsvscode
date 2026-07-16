//@ts-check

"use strict";

import { resolve as _resolve } from "path";
import copyPlugin from "copy-webpack-plugin";

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
  devtool: "source-map",
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
    path: _resolve(__dirname, "dist"),
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
  devtool: "source-map",
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
    path: _resolve(__dirname, "dist"),
    filename: "webview.js",
    libraryTarget: "module",
    chunkFormat: "module"
  },
  plugins: [
    new copyPlugin({
      patterns: [
        {
          from: "./src/webview/style.css",
          to: _resolve(__dirname, "dist")
        },
        {
          from: "./src/backend/SCM_API.sdp",
          to: _resolve(__dirname, "dist")
        },
        {
          from: "./resources/instructions",
          to: _resolve(__dirname, "dist/instructions")
        }
      ]
    })
  ]
};

/** @type WebpackConfig */
const jsServerConfig = {
  mode: "none",
  target: "node",
  externals: {
    vscode: "commonjs vscode",
    typescript: "commonjs typescript",
  },
  resolve: {
    extensions: [".ts", ".js"]
  },
  devtool: "source-map",
  infrastructureLogging: {
    level: "log"
  },
  entry: "./src/lsp/js/server.ts",
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{
          loader: "ts-loader",
          options: {
            configFile: _resolve(__dirname, "tsconfig.js-lsp.json"),
            transpileOnly: true
          }
        }]
      }
    ]
  },
  plugins: [
    new copyPlugin({
      patterns: [
        {
          from: "./src/lsp/globals.d.ts",
          to: _resolve(__dirname, "dist/starlims-globals.d.ts")
        }
      ]
    })
  ],
  output: {
    path: _resolve(__dirname, "dist"),
    filename: "js-language-server.js",
    libraryTarget: "commonjs2"
  }
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
  devtool: "source-map",
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
            configFile: _resolve(__dirname, "tsconfig.server.json"),
            transpileOnly: true
          }
        }]
      },
      {}
    ]
  },
  output: {
    path: _resolve(__dirname, "dist"),
    filename: "ssl-language-server.js",
    libraryTarget: "commonjs2"
  }
};

export default [extensionConfig, webviewConfig, serverConfig, jsServerConfig];
