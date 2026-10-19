import * as assert from 'assert';
import { CheckedOutTreeDataProvider } from '../../providers/checkedOutTreeDataProvider';
import { EnterpriseService } from '../../services/enterpriseService';

/**
 * One row of the pending checkins dataset (SCM_API.TicketManagement / CheckInProvider.GetPendingCheckins).
 * The server sends a .NET DataSet whose rows are "PendingCheckins" elements with the
 * fields as child elements - the schema part of the document is not needed here.
 */
const CHECKOUT_XML = `<?xml version="1.0" encoding="utf-8"?>
<DataSet>
  <PendingCheckins>
    <CHILDID>11111111-1111-1111-1111-111111111111</CHILDID>
    <PARENTID>22222222-2222-2222-2222-222222222222</PARENTID>
    <CHILDNAME>scTest</CHILDNAME>
    <ParentName>util</ParentName>
    <CHECKEDOUTBY>alice</CHECKEDOUTBY>
    <CHILDTYPE>ServerScript</CHILDTYPE>
    <PARENTTYPE>SSC</PARENTTYPE>
    <CHECKEDOUTDATE>2026-10-19 09:00:00</CHECKEDOUTDATE>
    <SCRIPTLANGUAGE>SSL</SCRIPTLANGUAGE>
    <APPCATNAME></APPCATNAME>
    <ISSYSTEM>N</ISSYSTEM>
    <LANGID></LANGID>
  </PendingCheckins>
</DataSet>`;

function createServiceStub() {
  const calls: { uri: string; user: string }[] = [];
  const service = {
    getConfig: () => ({ get: () => "currentuser" }),
    setCheckedOut: async (uri: string, user: string) => {
      calls.push({ uri, user });
    }
  } as unknown as EnterpriseService;
  return { calls, service };
}

suite('CheckedOutTreeDataProvider', () => {
  test('parses the pending checkins into leaf items', () => {
    const { service } = createServiceStub();
    const provider = new CheckedOutTreeDataProvider(CHECKOUT_XML, service);

    const leaves = provider.getLeafItems();
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].label, "scTest");
    assert.strictEqual(leaves[0].checkedOutBy, "alice");
    assert.strictEqual(leaves[0].uri, "/ServerScripts/util/scTest");
  });

  test('registers the checked out items in the enterprise service by default', () => {
    const { calls, service } = createServiceStub();
    new CheckedOutTreeDataProvider(CHECKOUT_XML, service);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].uri, "/ServerScripts/util/scTest");
    assert.strictEqual(calls[0].user, "alice");
  });

  test('does not change the checkout state when the registration is switched off', () => {
    // The transfer scope and the MCP tool "list_checked_out_items" parse the
    // checkouts of other users with a transient provider - registering them would
    // mark their items as checked out in the whole workspace.
    const { calls, service } = createServiceStub();
    const provider = new CheckedOutTreeDataProvider(CHECKOUT_XML, service, false);

    assert.strictEqual(provider.getLeafItems().length, 1);
    assert.strictEqual(calls.length, 0);
  });
});
