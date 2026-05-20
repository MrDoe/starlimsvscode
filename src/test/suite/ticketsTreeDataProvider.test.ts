import * as assert from 'assert';
import { TicketsTreeDataProvider } from '../../providers/ticketsTreeDataProvider';
import { TicketOverview } from '../../services/ticketManagementTypes';

suite('TicketsTreeDataProvider integration tests', () => {
	test('applies the title filter to already loaded tickets without reloading them', async () => {
		let loadTicketsCalls = 0;
		const tickets: TicketOverview[] = [
			{
				id: 1,
				title: 'Alpha ticket',
				statusName: 'Open',
				statusGroupName: 'Offen'
			},
			{
				id: 2,
				title: 'Beta ticket',
				statusName: 'Open',
				statusGroupName: 'Offen'
			}
		];

		const provider = new TicketsTreeDataProvider({
			getActiveTicket: () => undefined,
			getCurrentUser: () => 'TESTUSER',
			loadTickets: async () => {
				loadTicketsCalls += 1;
				return tickets;
			},
			loadTicketDescription: async () => undefined
		});

		const initialGroups = await provider.getChildren();
		assert.strictEqual(loadTicketsCalls, 1);
		assert.strictEqual(initialGroups.length, 5);

		const openGroup = initialGroups.find((item) => item.statusGroupName === 'Offen');
		assert.ok(openGroup);
		assert.strictEqual(openGroup?.children?.length, 2);

		provider.setTitleFilter('beta');

		const filteredGroups = await provider.getChildren();
		assert.strictEqual(loadTicketsCalls, 1);
		assert.strictEqual(filteredGroups.length, 1);
		assert.strictEqual(filteredGroups[0].statusGroupName, 'Offen');
		assert.strictEqual(filteredGroups[0].children?.length, 1);
		assert.strictEqual(filteredGroups[0].children?.[0].ticket?.title, 'Beta ticket');
	});
});