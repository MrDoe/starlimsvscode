/* eslint-disable @typescript-eslint/naming-convention */
import fetch from "node-fetch";
import { Headers } from "node-fetch";
import * as vscode from "vscode";
import { promises as fs } from "fs";
import * as path from "path";
import { Enterprise } from "./enterprise";

/** STARLIMS Enterprise Designer service. Provides main services for the VS Code extensions,
 * at time using the SCM_API REST services in STARLIMS backed.
 */
export class EnterpriseService implements Enterprise {
  private config: any;
  private baseUrl: string;

  /** Constructor
   * @param config Workspace config object for the STARLIMS VS Code extension.
   */
  constructor(config: vscode.WorkspaceConfiguration) {
    this.config = config;
    this.baseUrl = this.cleanUrl(config.url);
  }

  /** Execute script remotely.
   * @param uri the URI of the remote script.
   */
  async runScript(uri: string) {
    const url = `${this.baseUrl}/SCM_API.RunScript.lims`;
    const headers = new Headers(this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify({
        URI: uri
      })
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      return;
    }
  }

  /** Gets the service config
   * @returns the service configuration settings */
  public getConfig(): vscode.WorkspaceConfiguration {
    return this.config;
  }

  /** Gets a descriptor of the STARLIMS Enterprise code item referenced by the specified URI.
   * @param uri the URI of the remote STARLIMS code item.
   * @returns A descriptor object with the following properties: name, type, uri, language, isFolder
   */
  public async getEnterpriseItem(uri: string) {
    const params = new URLSearchParams([["URI", uri]]);
    const url = `${this.baseUrl}/SCM_API.GetEnterpriseItems.lims?${params}`;
    const headers = new Headers(this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers,
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } =
        await response.json();
      if (success) {
        return data.items;
      } else {
        vscode.window.showErrorMessage("Could not retrieve enterprise items.");
        console.log(data);
        return [];
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve enterprise items.");
      return [];
    }
  }

  /** Gets the code and code language (XML, JS, SSL, SLSQL etc.) of the STARLIMS Enterprise Designer referenced
   * by the specified URI.
   * @param uri the URI of the remote STARLIMS script / code item.
   * @returns an object with Language: string and Code: string
   */
  public async getEnterpriseItemCode(uri: string) {
    const params = new URLSearchParams([["URI", uri]]);
    const url = `${this.baseUrl}/SCM_API.GetCode.lims?${params}`;
    const headers = new Headers(this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers,
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } =
        await response.json();
      if (success) {
        if(data.language === "JS") {
          // comment out all occurences of '#include' for eslint to work       
          data.code = data.code.replace(/^#include/gm, "//#include");
        }
        return data;
      } else {
        vscode.window.showErrorMessage("Could not retrieve item code.");
        console.log(data);
        return null;
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve item code.");
      return null;
    }
  }

  public async checkin(uri: string, reason: string) {
    
  }

  public async checkout(uri: string) {
    const params = new URLSearchParams([["URI", uri]]);
    const url = `${this.baseUrl}/SCM_API.GetEnterpriseItems.lims?${params}`;
    const headers = new Headers(this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers,
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } =
        await response.json();
      if (success) {
        return data.items;
      } else {
        vscode.window.showErrorMessage("Could not retrieve enterprise items.");
        console.log(data);
        return [];
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve enterprise items.");
      return [];
    }
  }

  /** Downloads the specified STARLIMS enterprise designer item to a local workspace folder.
   * @param uri the URI to the remote script / code item
   * @param workspaceFolder the local workspace folder where to download the file
   * @returns the local path to the downloaded file
   */
  public async getLocalCopy(
    uri: string,
    workspaceFolder: string
  ): Promise<string | null> {
    const item = await this.getEnterpriseItemCode(uri);
    if (item) {
      const localFilePath = path.join(workspaceFolder, `${uri}.${item.language.toLowerCase().replace("sql", "slsql")}`);

      try {
        const localFolder = path.dirname(localFilePath);
        await fs.mkdir(localFolder, { recursive: true });

        let writeFile = true;
        try {
          await fs.stat(localFilePath);
          let answer = await vscode.window.showInformationMessage("A local copy already exists. Would you like to overwrite it with the remote version?", "Yes", "No");
          writeFile = answer === "Yes";
        } catch {
          // ignore - file does not exist
        }

        if (writeFile) {
          // comment out all occurences of '#include' for eslint to work       
          item.code = item.code.replace(/^#include/gm, "//#include");

          await fs.writeFile(localFilePath, item.code, {
            encoding: "utf8",
          });
          vscode.window.showInformationMessage(
            `Code downloaded locally to ${localFilePath}`
          );
          return localFilePath;
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot write file ${localFilePath}.`);
        console.error(e);
      }
    }
    return null;
  }

/**
 * Saves the code of the STARLIMS Enterprise Designer item referenced by the specified URI.
 * @param uri The URI of the remote STARLIMS script / code item.
 * @param code The code to save.
 */
  public async saveEnterpriseItemCode(uri: string, code: string) {
    // uncomment all occurences of '#include'
    code = code.replace(/^\/\/#include/gm, "#include");
    const url = `${this.baseUrl}/SCM_API.SaveCode.lims`;
    const headers = new Headers(this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify({
        URI: uri,
        Code: code
      })
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
      if (success) {
        vscode.window.showInformationMessage("Code saved successfully.");
      } else {
        vscode.window.showErrorMessage("Could not save code.");
        console.log(data);
      }
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      return;
    }
  }

  /**
   * Get API headers for HTTP calls to STARLIMS.
   * @returns an array of string arrays with header name and value.
   */
  private getAPIHeaders(): string[][] {
    return [
      ["STARLIMSUser", this.config.user],
      ["STARLIMSPass", this.config.password],
      ["Content-Type", "application/json"],
      ["Accept", "*/*"],
    ];
  }

  /** 
   * Cleans up the configured app URL by removing unnecessary things suchs as extra / characters.
   * @param url the STARLIMS app URL
   * @returns the base URL for REST API calls */
  private cleanUrl(url: string) {
    let newUrl = url.endsWith("/") ? url.slice(0, -1) : url;
    if (newUrl.endsWith(".lims")) {
      newUrl = newUrl.slice(0, newUrl.lastIndexOf("/"));
    }
    return newUrl;
  }
}
