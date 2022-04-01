/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from "vscode";
import { Enterprise } from "./services/enterprise";

/**
 * Implements the VS Code TreeDataProvider to build the STARLIMS designer tree explorer.
 */
export class EnterpriseTreeDataProvider
  implements vscode.TreeDataProvider<TreeEnterpriseItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<TreeEnterpriseItem | null> =
    new vscode.EventEmitter<TreeEnterpriseItem | null>();
  readonly onDidChangeTreeData: vscode.Event<TreeEnterpriseItem | null> =
    this._onDidChangeTreeData.event;

  private service: Enterprise;

  constructor(enterpriseService: Enterprise) {
    this.service = enterpriseService;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(null);
  }

  public async getChildren(
    element?: TreeEnterpriseItem
  ): Promise<TreeEnterpriseItem[]> {
    var enterpriseTreeItems: TreeEnterpriseItem[] = [];
    var uri: string = element ? element.uri : "";

    let enterpriseItems: TreeEnterpriseItem[] =
      await this.service.getEnterpriseItem(uri);
    const _this = this;
    enterpriseItems.forEach(function (item: any) {
      let enterpriseTreeItem = new TreeEnterpriseItem(
        item.Type,
        item.Name,
        item.Language,
        item.URI,
        item.IsFolder
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );
      enterpriseTreeItem.command = {
        command: "STARLIMS.selectEnterpriseItem",
        title: "Select Node",
        arguments: [enterpriseTreeItem],
      };
      enterpriseTreeItem.contextValue = item.Type;
      enterpriseTreeItem.iconPath = _this.getItemIcon(item);
      enterpriseTreeItem.label = item.CheckedOutBy
        ? `${enterpriseTreeItem.label} (Checked out by ${item.CheckedOutBy})`
        : enterpriseTreeItem.label;
      enterpriseTreeItems.push(enterpriseTreeItem);
    });

    return enterpriseTreeItems;
  }

  getTreeItem(item: TreeEnterpriseItem): vscode.TreeItem {
    return item;
  }

  private getItemIcon(item: any): vscode.ThemeIcon {
    if (item.IsFolder) {
      return vscode.ThemeIcon.Folder;
    } else if (item.CheckedOutBy) {
      return new vscode.ThemeIcon("lock");
    } else {
      switch (item.Type) {
        case "DS":
        case "APPDS":
          return new vscode.ThemeIcon("database");
        case "SS":
        case "APPSS":
        case "APPCS":
        case "HTMLFORMCODE":
        case "XFDFORMCODE":
          return new vscode.ThemeIcon("file-code");
        case "XFDFORMXML":
        case "HTMLFORMXML":
          return new vscode.ThemeIcon("preview");
        default:
          return new vscode.ThemeIcon("file-code");
      }
    }
  }
}

export class TreeEnterpriseItem extends vscode.TreeItem {
  type: EnterpriseItemType;
  language: string;
  uri: string;
  constructor(
    type: EnterpriseItemType,
    label: string,
    language: string,
    uri: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.type = type;
    this.language = language;
    this.command = command;
    this.uri = uri;
  }
}

export enum EnterpriseItemType {
  EnterpriseCategory = "CATEGORY",
  AppCategory = "APPCATEGORY",
  Application = "APP",
  XFDFormXML = "XFDFORMXML",
  XFDFormCode = "XFDFORMCODE",
  HTMLFormXML = "HTMLFORMXML",
  HTMLFormCode = "HTMLFORMCODE",
  PhoneForm = "PHONEFORM",
  TabletForm = "TABLETFORM",
  AppServerScript = "APPSS",
  AppClientScript = "APPCS",
  AppDataSource = "APPDS",
  ServerScriptCategory = "SSCAT",
  ServerScript = "SS",
  ClientScriptCategory = "CSCAT",
  DataSource = "DS",
  DataSourceCategory = "DSCAT",
}
