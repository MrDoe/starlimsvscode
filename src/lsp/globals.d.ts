// STARLIMS Runtime globals for JS client scripts
// Hand-authored ambient declarations based on the STARLIMS JS runtime API.

interface Form {
  ShowModalDialog(module: string, args?: any[], callback?: (result: any) => void): void;
  Variables: { Get(name: string): any; Set(name: string, value: any): void; [key: string]: any };
  Close(): void;
  Refresh(): void;
  ShowMessage(msg: string): void;
  ShowYesNo(msg: string): boolean;
  MessageBox(msg: string, title?: string, buttons?: number): number;
  DataSources: { [name: string]: any };
  Controls: { [name: string]: any };
  [key: string]: any;
}

interface Navigator {
  Variables: { Get(name: string): any; Set(name: string, value: any): void; [key: string]: any };
  Open(url: string): void;
  [key: string]: any;
}

interface Utils {
  Variables: { Get(name: string): any; Set(name: string, value: any): void; [key: string]: any };
  [key: string]: any;
}

interface Starlims {
  Version: string;
  Navigator: Navigator;
  Utils: Utils;
  [key: string]: any;
}

interface LimsClient {
  CallServer(
    scriptName: string,
    params?: any[],
    longProcessing?: boolean,
    returnType?: number,
    onSuccess?: (response: any) => void,
    onFailure?: (response: any) => void,
    eOpts?: { timeout?: number; scope?: any },
  ): any;
  GetFormSource(uri: string): string;
  [key: string]: any;
}

// .NET interop classes commonly used in STARLIMS client scripts
declare class ArrayList {
  constructor();
  Add(item: any): void;
  Count: number;
  Item(index: number): any;
  ToArray(): any[];
  [key: string]: any;
}

declare class Hashtable {
  constructor();
  Add(key: any, value: any): void;
  Item(key: any): any;
  Contains(key: any): boolean;
  Remove(key: any): void;
  Count: number;
  Keys: any[];
  Values: any[];
  Clear(): void;
  [key: string]: any;
}

declare class StringBuilder {
  constructor(initial?: string);
  Append(text: string): void;
  AppendLine(text?: string): void;
  ToString(): string;
  Length: number;
  Clear(): void;
  [key: string]: any;
}

declare class Regex {
  constructor(pattern: string, options?: number);
  IsMatch(input: string): boolean;
  Match(input: string): { Success: boolean; Value: string; NextMatch(): any };
  Matches(input: string): { Count: number; Item(index: number): any };
  Replace(input: string, replacement: string): string;
  [key: string]: any;
}

declare class XmlDocument {
  constructor();
  Load(path: string): void;
  LoadXml(xml: string): void;
  OuterXml: string;
  InnerXml: string;
  SelectSingleNode(xpath: string): XmlNode | null;
  SelectNodes(xpath: string): XmlNodeList;
  DocumentElement: XmlNode;
  [key: string]: any;
}

interface XmlNode {
  Attributes: XmlAttributeCollection;
  ChildNodes: XmlNodeList;
  InnerText: string;
  InnerXml: string;
  Name: string;
  Value: string;
  SelectSingleNode(xpath: string): XmlNode | null;
  SelectNodes(xpath: string): XmlNodeList;
  [key: string]: any;
}

interface XmlAttributeCollection {
  Length: number;
  Item(index: number): XmlAttribute;
  GetNamedItem(name: string): XmlAttribute | null;
  [key: string]: any;
}

interface XmlAttribute {
  Name: string;
  Value: string;
  [key: string]: any;
}

interface XmlNodeList {
  Length: number;
  Item(index: number): XmlNode;
  [key: string]: any;
}

declare class DataTable {
  constructor();
  Columns: DataColumnCollection;
  Rows: DataRowCollection;
  Clear(): void;
  [key: string]: any;
}

interface DataColumnCollection {
  Count: number;
  Item(index: number): DataColumn;
  FindColumn(name: string): DataColumn;
  [key: string]: any;
}

interface DataColumn {
  Caption: string;
  DataType: any;
  Visible: boolean;
  Width: number;
  [key: string]: any;
}

interface DataRowCollection {
  Count: number;
  Item(index: number): DataRow;
  [key: string]: any;
}

interface DataRow {
  Item(index: number): any;
  Item(name: string): any;
  [key: string]: any;
}

declare class DataGrid {
  RowCount: number;
  RootTable: DataTable;
  GetRowData(columnName: string, rowIndex: number): any;
  [key: string]: any;
}

// StarLIMS form globals
declare var form: Form;
declare var navigator: Navigator;
declare var Utils: Utils;
declare var Starlims: Starlims;

// The 'lims' global is the AppFunctions instance
declare var AppFunctions: LimsClient;
declare var lims: LimsClient;

// Additional known globals from the STARLIMS eslint globals list
declare function ShowMessage(msg: string): void;
declare function ShowYesNo(msg: string): boolean;
declare function MessageBox(msg: string, title?: string, buttons?: number): number;

// ExtJS globals (used throughout client scripts)
declare namespace Ext {
  function define(className: string, config: any): void;
  function override(className: string, config: any): void;
  function create(className: string, config?: any): any;
  namespace util {
    class DelayedTask {
      constructor(fn?: Function, scope?: any);
      delay(delay: number, fn?: Function, scope?: any, args?: any[]): void;
      cancel(): void;
    }
  }
}

// Control variable types (commonly prefixed: txt, cbo, btn, dgd, pnl, lbl, chk, etc.)
// These are implicitly available via form.Controls but also exist as globals
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const txt: any;
declare const cbo: any;
declare const btn: any;
declare const dgd: any;
declare const pnl: any;
declare const lbl: any;
declare const chk: any;
