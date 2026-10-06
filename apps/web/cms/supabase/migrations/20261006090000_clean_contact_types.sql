-- Remove tipos de contato legados das pessoas (Contato Google, Importado,
-- Ex trabalho, LEAD), mantendo os demais. Pessoas sem outro tipo ficam vazias.
update public.contacts c
set contact_type = nullif(array_to_string(array(
  select trim(t)
  from unnest(regexp_split_to_array(coalesce(c.contact_type, ''), '\s*[;,]\s*')) as t
  where trim(t) <> ''
    and lower(trim(t)) not in ('contato google', 'importado', 'ex trabalho', 'lead')
), '; '), '')
where c.contact_type ~* '(contato google|importado|ex trabalho|lead)';
