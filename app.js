const state = {
	config: null,
	tasks: [],
	editingTaskId: null,
};

const taskForm = document.querySelector("#task-form");
const taskTitleInput = document.querySelector("#task-title");
const taskDescriptionInput = document.querySelector("#task-description");
const taskSubmitButton = document.querySelector("#task-submit");
const cancelEditButton = document.querySelector("#task-cancel-edit");
const taskList = document.querySelector("#task-list");
const statusMessage = document.querySelector("#status-message");

function setStatus(message, type = "info") {
	statusMessage.textContent = message;
	statusMessage.dataset.type = type;
}

function setFormEnabled(enabled) {
	taskTitleInput.disabled = !enabled;
	taskDescriptionInput.disabled = !enabled;
	taskSubmitButton.disabled = !enabled;
}

async function loadConfig() {
	const response = await fetch("config.json");
	if (!response.ok) {
		throw new Error("Could not load config.json. Check that the file is available.");
	}

	const config = await response.json();
	const supabaseUrl = typeof config.supabaseUrl === "string" ? config.supabaseUrl.trim() : "";
	const publishableKey = typeof config.supabasePublishableKey === "string"
		? config.supabasePublishableKey.trim()
		: "";
	const tableName = typeof config.tableName === "string" ? config.tableName.trim() : "";

	if (!supabaseUrl || !publishableKey || !tableName) {
		throw new Error("Add your Supabase URL, public publishable key, and table name in config.json.");
	}

	state.config = {
		supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
		publishableKey,
		tableName,
	};
}

function getTasksUrl(query = "") {
	const table = encodeURIComponent(state.config.tableName);
	return `${state.config.supabaseUrl}/rest/v1/${table}${query}`;
}

function getTaskById(id) {
	const encodedId = encodeURIComponent(String(id));
	return requestTasks("GET", `?id=eq.${encodedId}&select=*`).then((tasks) => {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			throw new Error("Task not found. It may have been deleted.");
		}
		return tasks[0];
	});
}

function requireAffectedTask(tasks, action) {
	if (!Array.isArray(tasks) || tasks.length === 0) {
		throw new Error(`Could not ${action} the task. It may no longer exist or you may not have permission.`);
	}
	return tasks[0];
}

async function requestTasks(method, query = "", body = undefined) {
	const headers = {
		apikey: state.config.publishableKey,
		Accept: "application/json",
	};

	// Legacy anon keys are JWTs; new sb_publishable_ keys belong only in apikey.
	if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(state.config.publishableKey)) {
		headers.Authorization = `Bearer ${state.config.publishableKey}`;
	}

	const options = {
		method,
		headers,
	};

	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		options.body = JSON.stringify(body);
	}
	if (["POST", "PATCH", "DELETE"].includes(method)) {
		headers.Prefer = "return=representation";
	}

	const response = await fetch(getTasksUrl(query), options);
	if (!response.ok) {
		let detail = "";
		try {
			const errorBody = await response.json();
			detail = errorBody.message || errorBody.details || errorBody.hint || "";
		} catch {
			detail = response.statusText;
		}
		throw new Error(detail ? `Supabase error: ${detail}` : `Supabase request failed (${response.status}).`);
	}

	if (response.status === 204) {
		return null;
	}

	const responseText = await response.text();
	return responseText ? JSON.parse(responseText) : null;
}

function createTaskElement(task) {
	const item = document.createElement("article");
	const isCompleted = Boolean(task.completed);
	item.className = `task-item${isCompleted ? " is-completed" : ""}`;
	item.dataset.id = task.id;

	const content = document.createElement("div");
	content.className = "task-content";

	const title = document.createElement("h3");
	title.className = "task-title";
	title.textContent = task.title || "Untitled task";
	content.append(title);

	const description = document.createElement("p");
	description.className = "task-description";
	description.textContent = task.description || "";
	content.append(description);

	const status = document.createElement("span");
	status.className = "task-status";
	status.textContent = isCompleted ? "Completed" : "Pending";
	content.append(status);

	const actions = document.createElement("div");
	actions.className = "task-actions";
	actions.append(
		createActionButton("toggle-task", isCompleted ? "Mark incomplete" : "Mark complete"),
		createActionButton("edit-task", "Edit"),
		createActionButton("delete-task", "Delete"),
	);

	item.append(content, actions);
	return item;
}

function createActionButton(className, label) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = className;
	button.textContent = label;
	return button;
}

function renderTasks() {
	taskList.replaceChildren();

	if (state.tasks.length === 0) {
		const emptyState = document.createElement("p");
		emptyState.className = "empty-state";
		emptyState.textContent = "No tasks yet. Add one to get started.";
		taskList.append(emptyState);
		return;
	}

	const taskElements = state.tasks.map(createTaskElement);
	taskList.append(...taskElements);
}

async function loadTasks() {
	taskList.innerHTML = '<p class="empty-state">Loading your tasks<span class="loading-dots" aria-hidden="true">...</span></p>';

	try {
		const tasks = await requestTasks("GET", "?select=*");
		state.tasks = Array.isArray(tasks) ? tasks : [];
		renderTasks();
		return true;
	} catch (error) {
		taskList.replaceChildren();
		const errorState = document.createElement("p");
		errorState.className = "empty-state";
		errorState.textContent = "Tasks could not be loaded. Check your connection and Supabase settings.";
		taskList.append(errorState);
		setStatus(error.message, "error");
		return false;
	}
}

function resetForm() {
	taskForm.reset();
	state.editingTaskId = null;
	taskSubmitButton.querySelector("span:last-child").textContent = "Add task";
	cancelEditButton.hidden = true;
}

async function handleFormSubmit(event) {
	event.preventDefault();

	const isEditing = state.editingTaskId !== null;
	const taskData = {
		title: taskTitleInput.value.trim(),
		description: taskDescriptionInput.value.trim(),
	};

	if (!taskData.title) {
		taskTitleInput.setCustomValidity("Please enter a task title.");
		taskTitleInput.reportValidity();
		return;
	}
	taskTitleInput.setCustomValidity("");

	taskSubmitButton.disabled = true;
	setStatus(isEditing ? "Saving your changes..." : "Adding your task...");

	try {
		if (isEditing) {
			const id = encodeURIComponent(String(state.editingTaskId));
			const updatedTasks = await requestTasks("PATCH", `?id=eq.${id}`, taskData);
			requireAffectedTask(updatedTasks, "update");
		} else {
			await requestTasks("POST", "", taskData);
		}

		resetForm();
		const loaded = await loadTasks();
		if (loaded) {
			setStatus(isEditing ? "Task updated successfully." : "Task added successfully.", "success");
		}
	} catch (error) {
		setStatus(error.message, "error");
	} finally {
		taskSubmitButton.disabled = false;
	}
}

function beginEditing(task) {
	state.editingTaskId = task.id;
	taskTitleInput.value = task.title || "";
	taskDescriptionInput.value = task.description || "";
	taskSubmitButton.querySelector("span:last-child").textContent = "Save changes";
	cancelEditButton.hidden = false;
	taskTitleInput.focus();
}

async function handleTaskAction(event) {
	const button = event.target.closest("button");
	const item = button && button.closest(".task-item");
	if (!item) return;

	const task = state.tasks.find((entry) => String(entry.id) === item.dataset.id);
	if (!task) return;

	if (button.classList.contains("edit-task")) {
		button.disabled = true;
		setStatus("Loading the latest task details...");
		try {
			const latestTask = await getTaskById(task.id);
			beginEditing(latestTask);
			setStatus("Task loaded for editing.", "success");
		} catch (error) {
			setStatus(error.message, "error");
		} finally {
			button.disabled = false;
		}
		return;
	}

	const id = encodeURIComponent(String(task.id));
	button.disabled = true;

	try {
		if (button.classList.contains("toggle-task")) {
			const updatedTasks = await requestTasks("PATCH", `?id=eq.${id}`, { completed: !Boolean(task.completed) });
			requireAffectedTask(updatedTasks, "update");
			setStatus(task.completed ? "Task marked as incomplete." : "Task marked as completed.", "success");
		} else if (button.classList.contains("delete-task")) {
			const deletedTasks = await requestTasks("DELETE", `?id=eq.${id}`);
			requireAffectedTask(deletedTasks, "delete");
			setStatus("Task deleted successfully.", "success");
		} else {
			return;
		}

		await loadTasks();
	} catch (error) {
		setStatus(error.message, "error");
	} finally {
		button.disabled = false;
	}
}

async function initialize() {
	setFormEnabled(false);

	try {
		await loadConfig();
		setFormEnabled(true);
		await loadTasks();
	} catch (error) {
		taskList.replaceChildren();
		const setupMessage = document.createElement("p");
		setupMessage.className = "empty-state";
		setupMessage.textContent = "Connect a Supabase project to load and manage tasks.";
		taskList.append(setupMessage);
		setStatus(error.message, "error");
	}
}

taskForm.addEventListener("submit", handleFormSubmit);
taskList.addEventListener("click", handleTaskAction);
cancelEditButton.addEventListener("click", resetForm);

initialize();
