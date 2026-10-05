import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Snackbar, Link,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import ContactsOutlinedIcon from '@mui/icons-material/ContactsOutlined';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import CustomerForm from '../components/customers/CustomerForm';
import CustomerContactTable from '../components/customers/CustomerContactTable';
import CustomerContactForm from '../components/customers/CustomerContactForm';
import CustomerAddressTable from '../components/customers/CustomerAddressTable';
import CustomerAddressForm from '../components/customers/CustomerAddressForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getCustomer, updateCustomer, friendlyCustomerError,
} from '../services/customerService';
import {
  getContactsByCustomer, createContact, updateContact,
  deactivateContact, reactivateContact, setPrimaryContact, friendlyContactError,
} from '../services/customerContactService';
import {
  getAddressesByCustomer, createAddress, updateAddress,
  deactivateAddress, reactivateAddress, setPrimaryAddress, friendlyAddressError,
} from '../services/customerAddressService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customer profile (P2L-3)
//
// Shows a single customer's information plus its Contacts and Addresses, each
// with add/edit/deactivate/reactivate and an atomic "set as primary" action.
// All data access is through the customer / contact / address services (never
// Supabase directly). Org-scoped: reloads on activeOrgId / id change. No sales
// orders, pricing, or any later P2L phase.
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

function CustomerProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [customer, setCustomer] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  // Customer edit
  const [editOpen, setEditOpen] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Contact dialog
  const [contactOpen, setContactOpen] = useState(false);
  const [contactMode, setContactMode] = useState('create');
  const [contactTarget, setContactTarget] = useState(null);
  const [savingContact, setSavingContact] = useState(false);
  const [contactDeactivate, setContactDeactivate] = useState(null);
  const [contactDeactivating, setContactDeactivating] = useState(false);

  // Address dialog
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressMode, setAddressMode] = useState('create');
  const [addressTarget, setAddressTarget] = useState(null);
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressDeactivate, setAddressDeactivate] = useState(null);
  const [addressDeactivating, setAddressDeactivating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getCustomer(id);
    if (err) { setError(friendlyCustomerError(err)); setLoading(false); return; }
    if (!data) { setError('Customer not found.'); setLoading(false); return; }
    setCustomer(data);
    const [contactsRes, addressesRes] = await Promise.all([
      getContactsByCustomer(id),
      getAddressesByCustomer(id),
    ]);
    if (!contactsRes.error) setContacts(contactsRes.data || []);
    if (!addressesRes.error) setAddresses(addressesRes.data || []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (!activeOrgId) { setCustomer(null); setContacts([]); setAddresses([]); return; }
    setCustomer(null); setContacts([]); setAddresses([]);
    load();
  }, [activeOrgId, load]);

  const reloadChildren = useCallback(async () => {
    const [contactsRes, addressesRes] = await Promise.all([
      getContactsByCustomer(id),
      getAddressesByCustomer(id),
    ]);
    if (!contactsRes.error) setContacts(contactsRes.data || []);
    if (!addressesRes.error) setAddresses(addressesRes.data || []);
  }, [id]);

  // ── Customer edit ──
  const handleCustomerEdit = async (values) => {
    setSavingCustomer(true);
    const { error: err } = await updateCustomer(id, values);
    setSavingCustomer(false);
    if (err) { setError(friendlyCustomerError(err)); return; }
    setEditOpen(false); setToast('Customer updated.');
    await load();
  };

  // ── Contacts ──
  const openContactCreate = () => { setContactMode('create'); setContactTarget(null); setContactOpen(true); };
  const openContactEdit = (c) => { setContactMode('edit'); setContactTarget(c); setContactOpen(true); };
  const handleContactSubmit = async (values) => {
    setSavingContact(true);
    const res = contactMode === 'edit' ? await updateContact(contactTarget.id, values) : await createContact(id, values);
    setSavingContact(false);
    if (res.error) { setError(friendlyContactError(res.error)); return; }
    setContactOpen(false); setContactTarget(null);
    setToast(contactMode === 'edit' ? 'Contact updated.' : 'Contact added.');
    await reloadChildren();
  };
  const handleContactSetPrimary = async (c) => {
    const { error: err } = await setPrimaryContact(c.id);
    if (err) { setError(friendlyContactError(err)); return; }
    setToast('Primary contact updated.'); await reloadChildren();
  };
  const handleContactDeactivate = async () => {
    if (!contactDeactivate) return;
    setContactDeactivating(true);
    const { error: err } = await deactivateContact(contactDeactivate.id);
    setContactDeactivating(false); setContactDeactivate(null);
    if (err) { setError(friendlyContactError(err)); return; }
    setToast('Contact deactivated.'); await reloadChildren();
  };
  const handleContactReactivate = async (c) => {
    const { error: err } = await reactivateContact(c.id);
    if (err) { setError(friendlyContactError(err)); return; }
    setToast('Contact reactivated.'); await reloadChildren();
  };

  // ── Addresses ──
  const openAddressCreate = () => { setAddressMode('create'); setAddressTarget(null); setAddressOpen(true); };
  const openAddressEdit = (a) => { setAddressMode('edit'); setAddressTarget(a); setAddressOpen(true); };
  const handleAddressSubmit = async (values) => {
    setSavingAddress(true);
    const res = addressMode === 'edit' ? await updateAddress(addressTarget.id, values) : await createAddress(id, values);
    setSavingAddress(false);
    if (res.error) { setError(friendlyAddressError(res.error)); return; }
    setAddressOpen(false); setAddressTarget(null);
    setToast(addressMode === 'edit' ? 'Address updated.' : 'Address added.');
    await reloadChildren();
  };
  const handleAddressSetPrimary = async (a) => {
    const { error: err } = await setPrimaryAddress(a.id);
    if (err) { setError(friendlyAddressError(err)); return; }
    setToast('Primary address updated.'); await reloadChildren();
  };
  const handleAddressDeactivate = async () => {
    if (!addressDeactivate) return;
    setAddressDeactivating(true);
    const { error: err } = await deactivateAddress(addressDeactivate.id);
    setAddressDeactivating(false); setAddressDeactivate(null);
    if (err) { setError(friendlyAddressError(err)); return; }
    setToast('Address deactivated.'); await reloadChildren();
  };
  const handleAddressReactivate = async (a) => {
    const { error: err } = await reactivateAddress(a.id);
    if (err) { setError(friendlyAddressError(err)); return; }
    setToast('Address reactivated.'); await reloadChildren();
  };

  if (loading) {
    return (
      <PageContainer maxWidth={1200} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Skeleton width={160} height={32} sx={{ mb: 2 }} />
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
          <Skeleton width="40%" height={36} sx={{ mb: 2 }} />
          <Grid container spacing={3}>
            {[0, 1, 2, 3, 4, 5].map((i) => <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>)}
          </Grid>
        </Paper>
      </PageContainer>
    );
  }

  if (error && !customer) {
    return (
      <PageContainer maxWidth={1200} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/customers')} color="inherit" sx={{ mb: 2 }}>Back to Customers</Button>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>
      </PageContainer>
    );
  }

  if (!customer) return null;

  return (
    <PageContainer maxWidth={1200} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/customers')} color="inherit" sx={{ mb: 2 }}>Back to Customers</Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {/* Customer information */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
              <StorefrontOutlinedIcon />
            </Box>
            <Box>
              <Typography variant="h3" component="h1">{customer.legalName}</Typography>
              <Chip label={customer.isActive ? 'Active' : 'Inactive'} size="small" color={customer.isActive ? 'success' : 'default'} sx={{ fontWeight: 600, mt: 0.5 }} />
            </Box>
          </Box>
          <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)} sx={{ flexShrink: 0 }}>Edit</Button>
        </Box>

        <Divider sx={{ mb: 3 }} />

        <Grid container spacing={3}>
          <Grid item xs={12} sm={6} md={4}><Field label="Legal Name">{customer.legalName}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Trading Name">{customer.tradingName || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Customer Type">{customer.customerType}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Registration Number">{customer.registrationNumber || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="VAT Number">{customer.vatNumber || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Email">{customer.email ? <Link href={`mailto:${customer.email}`} underline="hover">{customer.email}</Link> : '—'}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Phone">{customer.phone || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Website">{customer.website ? <Link href={customer.website} target="_blank" rel="noopener" underline="hover">{customer.website}</Link> : '—'}</Field>
          </Grid>
          <Grid item xs={12}><Field label="Notes">{customer.notes || '—'}</Field></Grid>
        </Grid>
      </Paper>

      {/* Contacts */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><ContactsOutlinedIcon /></Box>
            <Typography variant="h5" component="h2">Contacts</Typography>
          </Box>
          <Button variant="outlined" color="primary" startIcon={<AddOutlinedIcon />} onClick={openContactCreate} sx={{ flexShrink: 0 }}>Add Contact</Button>
        </Box>
        {contacts.length === 0 ? (
          <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: 4, textAlign: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>No contacts yet for this customer.</Typography>
            <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openContactCreate}>Add Contact</Button>
          </Paper>
        ) : (
          <CustomerContactTable
            contacts={contacts}
            onSetPrimary={handleContactSetPrimary}
            onEdit={openContactEdit}
            onDeactivate={setContactDeactivate}
            onReactivate={handleContactReactivate}
          />
        )}
      </Paper>

      {/* Addresses */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><PlaceOutlinedIcon /></Box>
            <Typography variant="h5" component="h2">Addresses</Typography>
          </Box>
          <Button variant="outlined" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAddressCreate} sx={{ flexShrink: 0 }}>Add Address</Button>
        </Box>
        {addresses.length === 0 ? (
          <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: 4, textAlign: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>No addresses yet for this customer.</Typography>
            <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAddressCreate}>Add Address</Button>
          </Paper>
        ) : (
          <CustomerAddressTable
            addresses={addresses}
            onSetPrimary={handleAddressSetPrimary}
            onEdit={openAddressEdit}
            onDeactivate={setAddressDeactivate}
            onReactivate={handleAddressReactivate}
          />
        )}
      </Paper>

      {/* Dialogs */}
      <CustomerForm open={editOpen} mode="edit" customer={customer} saving={savingCustomer} onSubmit={handleCustomerEdit} onClose={() => setEditOpen(false)} />
      <CustomerContactForm open={contactOpen} mode={contactMode} contact={contactTarget} saving={savingContact} onSubmit={handleContactSubmit} onClose={() => { setContactOpen(false); setContactTarget(null); }} />
      <CustomerAddressForm open={addressOpen} mode={addressMode} address={addressTarget} saving={savingAddress} onSubmit={handleAddressSubmit} onClose={() => { setAddressOpen(false); setAddressTarget(null); }} />
      <ConfirmDialog
        open={Boolean(contactDeactivate)} title="Deactivate Contact?"
        message="This contact will be retained but hidden from the active list. You can reactivate it later."
        confirmLabel="Deactivate" confirmColor="error" loading={contactDeactivating}
        onConfirm={handleContactDeactivate} onClose={() => setContactDeactivate(null)}
      />
      <ConfirmDialog
        open={Boolean(addressDeactivate)} title="Deactivate Address?"
        message="This address will be retained but hidden from the active list. You can reactivate it later."
        confirmLabel="Deactivate" confirmColor="error" loading={addressDeactivating}
        onConfirm={handleAddressDeactivate} onClose={() => setAddressDeactivate(null)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default CustomerProfile;
