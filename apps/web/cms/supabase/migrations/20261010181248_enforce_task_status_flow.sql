create or replace function public.activity_status_transition_allowed(previous_status text, next_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    previous_status = next_status
    or (previous_status = 'todo' and next_status in ('doing', 'canceled'))
    or (previous_status = 'doing' and next_status in ('done', 'canceled'))
    or (previous_status = 'canceled' and next_status in ('todo', 'doing', 'done')),
    false
  );
$$;

create or replace function public.enforce_activity_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.activity_status_transition_allowed(old.status, new.status) then
    raise exception using
      errcode = '23514',
      message = case when old.status = 'done'
        then 'Tarefa Atendida nao pode ter o status alterado.'
        else 'Transicao invalida: Em aberto para Em andamento ou Cancelado; Em andamento para Atendido ou Cancelado.'
      end;
  end if;
  return new;
end;
$$;

create trigger enforce_activity_status_transition
before update of status on public.activities
for each row
when (old.status is distinct from new.status)
execute function public.enforce_activity_status_transition();
